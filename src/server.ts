import express from "express";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApp } from "./api/app.ts";
import { JobStore } from "./db/jobStore.ts";
import { SettingsStore } from "./db/settingsStore.ts";
import { runDetectionSession } from "./detection/session.ts";
import { resolveSegments } from "./download/resolveSegments.ts";
import { downloadToFile } from "./download/job.ts";
import { relocateFile } from "./download/relocateFile.ts";
import { transcodeToMkvAv1 } from "./download/transcode.ts";

const PORT = Number(process.env.PORT ?? 3000);
// Fast local scratch space segments are written to first (e.g. an SSD) — kept separate from
// DOWNLOADS_DIR so a slow/high-latency final destination (e.g. an NFS mount) never sits on the
// hot path of an in-progress download (ADR-0005).
const CACHE_DIR = process.env.CACHE_DIR ?? join(process.cwd(), "cache");
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? join(process.cwd(), "downloads");
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), "data", "ditch.sqlite");

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  await mkdir(dirname(DB_PATH), { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  const jobStore = new JobStore(db);
  const settingsStore = new SettingsStore(db);
  jobStore.failAllInProgress("伺服器重啟，任務中斷");

  // Jobs still "queued" from before the restart survive (ADR-0009) but can't auto-resume this
  // session — their candidate/headers only ever lived in memory, not in the DB. They'll sit in
  // the queue until the user cancels and resubmits them.
  const orphanedQueue = jobStore.listQueued();
  if (orphanedQueue.length > 0) {
    console.warn(
      `${orphanedQueue.length} job(s) were still queued before restart and won't auto-resume: ${orphanedQueue.map((j) => j.id).join(", ")}`,
    );
  }
  // Same restart caveat as the Queue above, but for the Transcode Queue (ADR-0013): the
  // cache path/duration a waiting job needs only ever lived in memory.
  const orphanedTranscodeQueue = jobStore.listTranscodeQueued();
  if (orphanedTranscodeQueue.length > 0) {
    console.warn(
      `${orphanedTranscodeQueue.length} job(s) were still waiting to transcode before restart and won't auto-resume: ${orphanedTranscodeQueue.map((j) => j.id).join(", ")}`,
    );
  }

  const app = createApp({
    jobStore,
    settingsStore,
    cacheDir: CACHE_DIR,
    downloadsDir: DOWNLOADS_DIR,
    runDetection: (pageUrl, onCandidate) => runDetectionSession(pageUrl, { onCandidate }),
    resolveSegments,
    downloadToFile,
    relocateFile,
    transcode: transcodeToMkvAv1,
  });

  app.use(express.static(join(import.meta.dirname, "public")));

  const server = app.listen(PORT, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : PORT;
    console.log(`ditch listening on http://localhost:${actualPort}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
