import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { stat, access, mkdir, rm, readdir } from "node:fs/promises";
import { SseChannel } from "./sseChannel.ts";
import { JobStore } from "../db/jobStore.ts";
import { SettingsStore } from "../db/settingsStore.ts";
import { sanitizeDestinationFolder, sanitizeFolderName } from "../download/destinationFolder.ts";
import type { Candidate } from "../detection/types.ts";
import type { DetectionResult } from "../detection/session.ts";
import type { DownloadJobRecord } from "../db/types.ts";
import type { ManifestSegment } from "../download/manifest/types.ts";
import type { DownloadProgress, DownloadRequestOptions } from "../download/job.ts";
import type { TranscodeHandle, TranscodeProgress } from "../download/transcode.ts";

export interface AppDependencies {
  jobStore: JobStore;
  settingsStore: SettingsStore;
  /** Fast local scratch space (e.g. an SSD) that segments are downloaded into first. */
  cacheDir: string;
  /** Final resting place for completed downloads (e.g. an NFS mount) — may be slow/high-latency. */
  downloadsDir: string;
  runDetection: (pageUrl: string, onCandidate: (candidate: Candidate) => void) => Promise<DetectionResult>;
  resolveSegments: (candidate: Candidate, headers: DownloadRequestOptions) => Promise<ManifestSegment[]>;
  downloadToFile: (
    segments: ManifestSegment[],
    outputPath: string,
    options: DownloadRequestOptions,
    onProgress?: (progress: DownloadProgress) => void,
  ) => Promise<void>;
  /** Moves the completed file from the cache into its final destination (see ADR-0005). */
  relocateFile: (sourcePath: string, destPath: string) => Promise<void>;
  /** Re-encodes video to AV1/MKV, copying audio as-is (ADR-0012). Only invoked when a job's transcodeEnabled is true. */
  transcode: (
    inputPath: string,
    outputPath: string,
    totalDurationSeconds: number,
    onProgress?: (progress: TranscodeProgress) => void,
  ) => TranscodeHandle;
}

interface DetectionEntry {
  channel: SseChannel<{ type: "candidate" | "done" | "error"; data: unknown }>;
  candidates: Candidate[];
  result?: DetectionResult;
}

type DownloadEventType =
  | "queued"
  | "progress"
  | "transcodeQueued"
  | "transcoding"
  | "moving"
  | "done"
  | "error"
  | "cancelled";

function sanitizeFilename(name: string): string {
  const base = basename(name).trim();
  return base.length > 0 ? base : "download";
}

/** Forces a filename's extension to .mkv (ADR-0012 Q9) — used whenever a job will transcode. */
function withMkvExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.mkv`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.use(express.json());

  const detections = new Map<string, DetectionEntry>();
  const downloadChannels = new Map<string, SseChannel<{ type: DownloadEventType; data: unknown }>>();
  // What a queued/pending job needs to actually run, keyed by job id — set at creation time,
  // dropped once the job leaves the system (moving/completed/failed/cancelled). Not persisted:
  // a "queued" job surviving a server restart (ADR-0009) has no entry here, so it stays queued
  // but won't auto-resume until the user cancels and resubmits it.
  const jobWork = new Map<string, { candidate: Candidate; headers: DownloadRequestOptions }>();
  // A job waiting in the Transcode Queue (ADR-0013) parks here — resolve() (called by
  // promoteTranscodeQueued once a slot frees up) lets its pipeline continue into transcoding;
  // reject() (called when the DELETE handler cancels a still-queued job) unwinds it instead.
  // Not persisted, same restart caveat as jobWork/queued above.
  const transcodeSlotWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  // The currently-running ffmpeg process for each actively-transcoding job, so the DELETE
  // handler can kill it (ADR-0013's cancel-mid-transcode support).
  const transcodeHandles = new Map<string, TranscodeHandle>();

  /** Tells every still-queued job's subscriber where it now sits in line (1-based, oldest first). */
  function broadcastQueuePositions(): void {
    deps.jobStore.listQueued().forEach((job, index) => {
      downloadChannels.get(job.id)?.publish({ type: "queued", data: { position: index + 1 } });
    });
  }

  /** Fills free execution slots with the longest-waiting queued jobs (ADR-0009). */
  function promoteQueued(): void {
    let promoted = false;
    while (deps.jobStore.countActive() < deps.settingsStore.getConcurrencyLimit()) {
      const next = deps.jobStore.nextQueued();
      if (!next) break;
      const work = jobWork.get(next.id);
      if (!work) break; // orphaned by a restart — no execution data to resume with
      runJob(next, work);
      promoted = true;
    }
    if (promoted) broadcastQueuePositions(); // jobs behind the promoted one moved up
  }

  /** Tells every still-transcode-queued job's subscriber where it now sits in line (ADR-0013). */
  function broadcastTranscodeQueuePositions(): void {
    deps.jobStore.listTranscodeQueued().forEach((job, index) => {
      downloadChannels.get(job.id)?.publish({ type: "transcodeQueued", data: { position: index + 1 } });
    });
  }

  /** Fills free transcode slots with the longest-waiting transcodeQueued jobs (ADR-0013). */
  function promoteTranscodeQueued(): void {
    let promoted = false;
    while (deps.jobStore.countActiveTranscode() < deps.settingsStore.getTranscodeConcurrencyLimit()) {
      const next = deps.jobStore.nextTranscodeQueued();
      if (!next) break;
      const waiter = transcodeSlotWaiters.get(next.id);
      if (!waiter) break; // orphaned by a restart — no in-memory continuation to resume
      transcodeSlotWaiters.delete(next.id);
      deps.jobStore.markTranscoding(next.id);
      waiter.resolve();
      promoted = true;
    }
    if (promoted) broadcastTranscodeQueuePositions();
  }

  /**
   * Resolves once `job` holds a transcode slot — immediately if one's free, otherwise after
   * waiting in the Transcode Queue until promoteTranscodeQueued() picks it (ADR-0013). Rejects
   * if the job is cancelled while still waiting.
   */
  function acquireTranscodeSlot(job: DownloadJobRecord): Promise<void> {
    if (deps.jobStore.countActiveTranscode() < deps.settingsStore.getTranscodeConcurrencyLimit()) {
      deps.jobStore.markTranscoding(job.id);
      return Promise.resolve();
    }
    deps.jobStore.markTranscodeQueued(job.id);
    const position = deps.jobStore.listTranscodeQueued().length;
    downloadChannels.get(job.id)?.publish({ type: "transcodeQueued", data: { position } });
    return new Promise<void>((resolve, reject) => {
      transcodeSlotWaiters.set(job.id, { resolve, reject });
    });
  }

  function runJob(job: DownloadJobRecord, work: { candidate: Candidate; headers: DownloadRequestOptions }): void {
    const { candidate, headers } = work;
    const channel = downloadChannels.get(job.id)!;
    deps.jobStore.markPending(job.id);

    const cacheJobDir = join(deps.cacheDir, job.id);
    // While transcoding, the raw download and the transcoded result briefly coexist in cache
    // under different names — "source" for the pre-transcode bytes, job.filename (already
    // forced to .mkv, see withMkvExtension) for ffmpeg's output.
    const downloadPath = job.transcodeEnabled ? join(cacheJobDir, "source") : join(cacheJobDir, job.filename);
    const finalDir = join(deps.downloadsDir, job.destinationFolder);
    const finalPath = join(finalDir, job.filename);

    (async () => {
      await mkdir(cacheJobDir, { recursive: true });
      const segments = await deps.resolveSegments(candidate, headers);
      await deps.downloadToFile(segments, downloadPath, headers, (progress) => {
        const fraction = progress.totalSegments > 0 ? progress.completedSegments / progress.totalSegments : 0;
        deps.jobStore.updateProgress(job.id, fraction);
        channel.publish({ type: "progress", data: progress });
      });

      jobWork.delete(job.id);

      let sourceForRelocate = downloadPath;
      if (job.transcodeEnabled) {
        // acquireTranscodeSlot() synchronously moves the job to transcodeQueued or transcoding
        // — either way, out of the ('pending'|'downloading') set countActive() checks — so it's
        // safe to free the download slot right after calling it, same as markMoving() below for
        // the non-transcoding path. Calling promoteQueued() beforehand would under-count: the
        // job's status would still read "downloading" and it'd still occupy its own slot.
        const slotAcquired = acquireTranscodeSlot(job);
        promoteQueued();
        await slotAcquired; // may have waited in the Transcode Queue; throws if cancelled while waiting
        channel.publish({ type: "transcoding", data: {} });

        const totalDurationSeconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
        const mkvPath = join(cacheJobDir, job.filename);
        const handle = deps.transcode(downloadPath, mkvPath, totalDurationSeconds, (progress) => {
          const fraction = progress.totalSeconds > 0 ? progress.encodedSeconds / progress.totalSeconds : 0;
          deps.jobStore.updateTranscodeProgress(job.id, fraction);
          channel.publish({ type: "transcoding", data: progress });
        });
        transcodeHandles.set(job.id, handle);
        try {
          await handle.done;
        } finally {
          transcodeHandles.delete(job.id);
        }

        await rm(downloadPath, { force: true }); // Q5: drop the pre-transcode original once it succeeded
        sourceForRelocate = mkvPath;

        // markMoving() must happen before promoteTranscodeQueued() — same reasoning as
        // promoteQueued() above: countActiveTranscode() only stops counting this job once its
        // status has actually left "transcoding".
        deps.jobStore.markMoving(job.id);
        channel.publish({ type: "moving", data: {} });
        promoteTranscodeQueued(); // transcoding -> moving frees this job's transcode slot
      } else {
        deps.jobStore.markMoving(job.id);
        channel.publish({ type: "moving", data: {} });
        promoteQueued(); // downloading -> moving frees this job's download slot
      }

      await mkdir(finalDir, { recursive: true });
      await deps.relocateFile(sourceForRelocate, finalPath);
      await rm(cacheJobDir, { recursive: true, force: true });

      deps.jobStore.markCompleted(job.id, finalPath);
      channel.publish({ type: "done", data: { outputPath: finalPath } });
      channel.close();
    })().catch((err: unknown) => {
      jobWork.delete(job.id);
      transcodeHandles.delete(job.id);
      if (deps.jobStore.get(job.id)?.status === "cancelled") {
        // The DELETE handler already updated the record, published "cancelled", and closed
        // the channel — nothing left to do here but free up the slots this job was holding.
        promoteQueued();
        promoteTranscodeQueued();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      deps.jobStore.markFailed(job.id, message);
      channel.publish({ type: "error", data: { message } });
      channel.close();
      promoteQueued();
      promoteTranscodeQueued();
    });
  }

  app.post("/api/detections", (req, res) => {
    const pageUrl = req.body?.pageUrl;
    if (typeof pageUrl !== "string" || pageUrl.length === 0) {
      res.status(400).json({ error: "pageUrl is required" });
      return;
    }

    const id = randomUUID();
    const entry: DetectionEntry = { channel: new SseChannel(), candidates: [] };
    detections.set(id, entry);
    res.status(202).json({ id });

    deps
      .runDetection(pageUrl, (candidate) => {
        entry.candidates.push(candidate);
        entry.channel.publish({ type: "candidate", data: candidate });
      })
      .then((result) => {
        entry.result = result;
        entry.channel.publish({
          type: "done",
          data: { referer: result.referer, userAgent: result.userAgent, cookie: result.cookie, pageTitle: result.pageTitle },
        });
        entry.channel.close();
      })
      .catch((err: unknown) => {
        entry.channel.publish({ type: "error", data: { message: err instanceof Error ? err.message : String(err) } });
        entry.channel.close();
      });
  });

  app.get("/api/detections/:id/events", (req, res) => {
    const entry = detections.get(req.params.id!);
    if (!entry) {
      res.status(404).end();
      return;
    }
    entry.channel.subscribe(res);
  });

  // Shared by every Candidate this Detection Session found — not ready until detection
  // finishes (the video needs time to render a frame), so 404 until then (ADR-0011).
  app.get("/api/detections/:id/thumbnail", (req, res) => {
    const thumbnail = detections.get(req.params.id!)?.result?.thumbnail;
    if (!thumbnail) {
      res.status(404).end();
      return;
    }
    res.set("Content-Type", thumbnail.contentType).send(thumbnail.data);
  });

  app.get("/api/folders", async (req, res) => {
    let relativeFolder: string;
    try {
      relativeFolder = sanitizeDestinationFolder(req.query.path);
    } catch {
      res.status(400).json({ error: "invalid_path" });
      return;
    }

    try {
      const entries = await readdir(join(deps.downloadsDir, relativeFolder), { withFileTypes: true });
      const folders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      res.json({ folders });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "folder_not_found" });
        return;
      }
      throw err;
    }
  });

  app.post("/api/folders", async (req, res) => {
    let relativeParent: string;
    let name: string;
    try {
      relativeParent = sanitizeDestinationFolder(req.body?.path);
      name = sanitizeFolderName(req.body?.name);
    } catch {
      res.status(400).json({ error: "invalid_path" });
      return;
    }

    await mkdir(join(deps.downloadsDir, relativeParent, name), { recursive: true });
    res.status(201).json({ path: relativeParent ? `${relativeParent}/${name}` : name });
  });

  app.post("/api/downloads", async (req, res) => {
    const { detectionId, candidateId, filename, overwrite } = req.body ?? {};
    const entry = detectionId ? detections.get(detectionId) : undefined;
    const candidate = entry?.candidates.find((c) => c.id === candidateId);
    if (!entry || !candidate) {
      res.status(404).json({ error: "unknown detectionId/candidateId" });
      return;
    }
    if (candidate.drmProtected) {
      res.status(422).json({ error: "candidate is DRM-protected and cannot be downloaded" });
      return;
    }

    let destinationFolder: string;
    try {
      destinationFolder = sanitizeDestinationFolder(req.body?.destinationFolder);
    } catch {
      res.status(400).json({ error: "invalid_destination_folder" });
      return;
    }

    // Frozen for this job's whole lifetime (Q8) — changing the setting afterwards never
    // retroactively changes an already-created job.
    const transcodeEnabled = deps.settingsStore.getTranscodeEnabled();
    let sanitizedFilename = sanitizeFilename(typeof filename === "string" && filename ? filename : "download");
    if (transcodeEnabled) sanitizedFilename = withMkvExtension(sanitizedFilename);
    const finalDir = join(deps.downloadsDir, destinationFolder);
    const finalPath = join(finalDir, sanitizedFilename);
    if (!overwrite && (await pathExists(finalPath))) {
      res.status(409).json({ error: "filename_conflict", filename: sanitizedFilename });
      return;
    }

    const headers: DownloadRequestOptions = {
      referer: entry.result?.referer,
      cookie: entry.result?.cookie,
      userAgent: entry.result?.userAgent,
    };
    const hasFreeSlot = deps.jobStore.countActive() < deps.settingsStore.getConcurrencyLimit();
    const job = deps.jobStore.create({
      sourcePageUrl: entry.result?.referer ?? "",
      candidateUrl: candidate.url,
      filename: sanitizedFilename,
      destinationFolder,
      initialStatus: hasFreeSlot ? "pending" : "queued",
      transcodeEnabled,
    });
    const channel = new SseChannel<{ type: DownloadEventType; data: unknown }>();
    downloadChannels.set(job.id, channel);
    jobWork.set(job.id, { candidate, headers });
    const queuePosition = hasFreeSlot ? undefined : deps.jobStore.listQueued().length;
    res.status(202).json({ id: job.id, status: job.status, queuePosition });

    if (hasFreeSlot) {
      runJob(job, { candidate, headers });
    }
  });

  // "Cancel" (queued, transcodeQueued, or transcoding) and "delete a history record"
  // (completed/failed/cancelled) are different concepts sharing one action — both mean "I
  // don't want this one anymore" (ADR-0010). Cancelling while transcoding kills the ffmpeg
  // process — unlike downloading, that's a clean operation (ADR-0013).
  app.delete("/api/downloads/:id", (req, res) => {
    const id = req.params.id!;

    if (deps.jobStore.cancel(id)) {
      jobWork.delete(id);
      const channel = downloadChannels.get(id);
      channel?.publish({ type: "cancelled", data: {} });
      channel?.close();
      downloadChannels.delete(id);
      broadcastQueuePositions(); // jobs behind the cancelled one moved up
      res.status(200).json({ ok: true });
      return;
    }

    const transcodeWaiter = transcodeSlotWaiters.get(id);
    if (transcodeWaiter && deps.jobStore.cancelTranscode(id)) {
      transcodeSlotWaiters.delete(id);
      const channel = downloadChannels.get(id);
      channel?.publish({ type: "cancelled", data: {} });
      channel?.close();
      downloadChannels.delete(id);
      transcodeWaiter.reject(new Error("cancelled"));
      broadcastTranscodeQueuePositions(); // jobs behind the cancelled one moved up
      res.status(200).json({ ok: true });
      return;
    }

    const transcodeHandle = transcodeHandles.get(id);
    if (transcodeHandle && deps.jobStore.cancelTranscode(id)) {
      transcodeHandles.delete(id);
      const channel = downloadChannels.get(id);
      channel?.publish({ type: "cancelled", data: {} });
      channel?.close();
      downloadChannels.delete(id);
      transcodeHandle.cancel(); // kills ffmpeg; its rejected done promise is absorbed by runJob's catch (status is already "cancelled")
      res.status(200).json({ ok: true });
      return;
    }

    const job = deps.jobStore.get(id);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!deps.jobStore.remove(id)) {
      res.status(409).json({ error: "not_deletable" }); // still holds an execution slot (pending/downloading/moving)
      return;
    }
    downloadChannels.get(id)?.close();
    downloadChannels.delete(id);
    res.status(200).json({ ok: true });
  });

  app.get("/api/settings", (_req, res) => {
    res.json({
      concurrencyLimit: deps.settingsStore.getConcurrencyLimit(),
      transcodeEnabled: deps.settingsStore.getTranscodeEnabled(),
      transcodeConcurrencyLimit: deps.settingsStore.getTranscodeConcurrencyLimit(),
    });
  });

  app.put("/api/settings", (req, res) => {
    const { concurrencyLimit, transcodeEnabled, transcodeConcurrencyLimit } = req.body ?? {};
    try {
      if (concurrencyLimit !== undefined) deps.settingsStore.setConcurrencyLimit(concurrencyLimit);
      if (transcodeEnabled !== undefined) deps.settingsStore.setTranscodeEnabled(Boolean(transcodeEnabled));
      if (transcodeConcurrencyLimit !== undefined) deps.settingsStore.setTranscodeConcurrencyLimit(transcodeConcurrencyLimit);
    } catch {
      res.status(400).json({ error: "invalid_settings" });
      return;
    }
    promoteQueued(); // a higher limit may free up slots for jobs already waiting
    promoteTranscodeQueued();
    res.json({
      concurrencyLimit: deps.settingsStore.getConcurrencyLimit(),
      transcodeEnabled: deps.settingsStore.getTranscodeEnabled(),
      transcodeConcurrencyLimit: deps.settingsStore.getTranscodeConcurrencyLimit(),
    });
  });

  app.get("/api/downloads", (_req, res) => {
    res.json(deps.jobStore.list());
  });

  app.get("/api/downloads/:id/events", (req, res) => {
    const id = req.params.id!;
    const channel = downloadChannels.get(id);
    if (channel) {
      channel.subscribe(res);
      return;
    }
    const job = deps.jobStore.get(id);
    if (!job) {
      res.status(404).end();
      return;
    }
    // No live channel (e.g. server restarted) — report final DB state as a single event.
    const fallback = new SseChannel<{ type: "progress" | "done" | "error" | "cancelled"; data: unknown }>();
    if (job.status === "completed") {
      fallback.publish({ type: "done", data: { outputPath: job.outputPath } });
    } else if (job.status === "failed") {
      fallback.publish({ type: "error", data: { message: job.errorMessage } });
    } else if (job.status === "cancelled") {
      fallback.publish({ type: "cancelled", data: {} });
    }
    fallback.close();
    fallback.subscribe(res);
  });

  app.get("/api/downloads/:id/file", async (req, res) => {
    const job = deps.jobStore.get(req.params.id!);
    if (!job || job.status !== "completed" || !job.outputPath) {
      res.status(404).end();
      return;
    }
    try {
      await stat(job.outputPath);
    } catch {
      res.status(404).end();
      return;
    }
    res.download(job.outputPath, job.filename);
  });

  return app;
}
