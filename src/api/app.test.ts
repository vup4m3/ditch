import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, readFile, access, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type AppDependencies } from "./app.ts";
import { JobStore } from "../db/jobStore.ts";
import { SettingsStore } from "../db/settingsStore.ts";
import { relocateFile } from "../download/relocateFile.ts";
import type { Candidate } from "../detection/types.ts";

interface TestDirs {
  cacheDir: string;
  downloadsDir: string;
}

async function withTempDirs<T>(fn: (dirs: TestDirs) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ditch-app-test-"));
  try {
    return await fn({ cacheDir: join(root, "cache"), downloadsDir: join(root, "downloads") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function startApp(deps: AppDependencies): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve) => {
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function readSse(baseUrl: string, path: string, count: number): Promise<Array<{ type: string; data: unknown }>> {
  const res = await fetch(`${baseUrl}${path}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ type: string; data: unknown }> = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const typeLine = chunk.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (typeLine && dataLine) {
        events.push({ type: typeLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
      }
    }
  }
  await reader.cancel();
  return events;
}

const CANDIDATE: Candidate = {
  id: "candidate-1",
  url: "https://example.com/hi/index.m3u8",
  type: "hls",
  label: "1080p",
  drmProtected: false,
};

function makeDeps({ cacheDir, downloadsDir }: TestDirs, overrides: Partial<AppDependencies> = {}): AppDependencies {
  const db = new DatabaseSync(":memory:");
  const jobStore = new JobStore(db);
  const settingsStore = new SettingsStore(db);
  return {
    jobStore,
    settingsStore,
    cacheDir,
    downloadsDir,
    runDetection: async (pageUrl, onCandidate) => {
      onCandidate(CANDIDATE);
      return { candidates: [CANDIDATE], referer: pageUrl, userAgent: "fake-agent/1.0", pageTitle: "Example Live Stream" };
    },
    resolveSegments: async () => [{ url: CANDIDATE.url, durationSeconds: 1, encryption: { method: "NONE" } }],
    downloadToFile: async (segments, outputPath, _options, onProgress) => {
      onProgress?.({ completedSegments: 1, totalSegments: 1 });
      await writeFile(outputPath, "fake-video-bytes");
    },
    relocateFile,
    // A fake ffmpeg: just copies the pre-transcode bytes through, reporting one progress tick.
    // Tests exercising real cancel-mid-transcode semantics override this with a gated version.
    transcode: (inputPath, outputPath, totalDurationSeconds, onProgress) => {
      const done = (async () => {
        onProgress?.({ encodedSeconds: totalDurationSeconds, totalSeconds: totalDurationSeconds });
        await copyFile(inputPath, outputPath);
      })();
      return { done, cancel: () => {} };
    },
    ...overrides,
  };
}

test("full happy path: detect, list candidate, download (via cache), see it complete, fetch the file", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      assert.equal(detectRes.status, 202);
      const { id: detectionId } = (await detectRes.json()) as { id: string };

      const detectionEvents = await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);
      assert.equal(detectionEvents[0]?.type, "candidate");
      assert.equal((detectionEvents[0]?.data as Candidate).id, "candidate-1");
      assert.equal(detectionEvents[1]?.type, "done");

      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "my video.ts" }),
      });
      assert.equal(downloadRes.status, 202);
      const { id: jobId } = (await downloadRes.json()) as { id: string };

      const downloadEvents = await readSse(baseUrl, `/api/downloads/${jobId}/events`, 3);
      assert.equal(downloadEvents[0]?.type, "progress");
      assert.equal(downloadEvents[1]?.type, "moving");
      assert.equal(downloadEvents[2]?.type, "done");

      const listRes = await fetch(`${baseUrl}/api/downloads`);
      const jobs = (await listRes.json()) as Array<{ id: string; status: string; filename: string; outputPath: string }>;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.id, jobId);
      assert.equal(jobs[0]?.status, "completed");
      assert.equal(jobs[0]?.filename, "my video.ts");
      assert.equal(
        jobs[0]!.outputPath,
        join(dirs.downloadsDir, "my video.ts"),
        "the final file should sit directly under downloadsDir, named exactly what the user typed — no job id anywhere",
      );

      // the cache copy is cleaned up once the file has been relocated to its final destination
      await assert.rejects(access(join(dirs.cacheDir, jobId)));

      const fileRes = await fetch(`${baseUrl}/api/downloads/${jobId}/file`);
      assert.equal(fileRes.status, 200);
      assert.equal(await fileRes.text(), "fake-video-bytes");
      assert.match(fileRes.headers.get("content-disposition") ?? "", /filename="my video\.ts"/);
    } finally {
      await close();
    }
  });
});

test("GET /api/detections/:id/thumbnail 404s for an unknown detection id", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const res = await fetch(`${baseUrl}/api/detections/does-not-exist/thumbnail`);
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  });
});

test("GET /api/detections/:id/thumbnail serves the session's shared thumbnail once detection finishes (ADR-0011)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        runDetection: async (pageUrl, onCandidate) => {
          onCandidate(CANDIDATE);
          return {
            candidates: [CANDIDATE],
            referer: pageUrl,
            userAgent: "fake-agent/1.0",
            pageTitle: "Example Live Stream",
            thumbnail: { data: Buffer.from("fake-jpeg-bytes"), contentType: "image/jpeg" },
          };
        },
      }),
    );
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const thumbRes = await fetch(`${baseUrl}/api/detections/${detectionId}/thumbnail`);
      assert.equal(thumbRes.status, 200);
      assert.equal(thumbRes.headers.get("content-type"), "image/jpeg");
      assert.equal(await thumbRes.text(), "fake-jpeg-bytes");
    } finally {
      await close();
    }
  });
});

test("GET /api/detections/:id/thumbnail 404s once detection finishes without finding a usable thumbnail", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs)); // default mock returns no thumbnail
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const thumbRes = await fetch(`${baseUrl}/api/detections/${detectionId}/thumbnail`);
      assert.equal(thumbRes.status, 404);
    } finally {
      await close();
    }
  });
});

test("rejects a download request that would overwrite an existing file with 409, unless overwrite is set", async () => {
  await withTempDirs(async (dirs) => {
    let attempt = 0;
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async (_segments, outputPath, _options, onProgress) => {
          attempt++;
          onProgress?.({ completedSegments: 1, totalSegments: 1 });
          await writeFile(outputPath, `bytes-from-attempt-${attempt}`);
        },
      }),
    );
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const firstRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "dup.ts" }),
      });
      assert.equal(firstRes.status, 202);
      const { id: firstJobId } = (await firstRes.json()) as { id: string };
      await readSse(baseUrl, `/api/downloads/${firstJobId}/events`, 3);

      const conflictRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "dup.ts" }),
      });
      assert.equal(conflictRes.status, 409);
      assert.equal((await conflictRes.json()).filename, "dup.ts");

      const jobsAfterConflict = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as unknown[];
      assert.equal(jobsAfterConflict.length, 1, "a rejected conflict must not create a job");

      const overwriteRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "dup.ts", overwrite: true }),
      });
      assert.equal(overwriteRes.status, 202);
      const { id: secondJobId } = (await overwriteRes.json()) as { id: string };
      await readSse(baseUrl, `/api/downloads/${secondJobId}/events`, 3);

      assert.equal(await readFile(join(dirs.downloadsDir, "dup.ts"), "utf8"), "bytes-from-attempt-2");
    } finally {
      await close();
    }
  });
});

test("rejects a download request for a DRM-protected candidate with 422", async () => {
  await withTempDirs(async (dirs) => {
    const drmCandidate: Candidate = { ...CANDIDATE, id: "candidate-drm", drmProtected: true };
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        runDetection: async (pageUrl, onCandidate) => {
          onCandidate(drmCandidate);
          return { candidates: [drmCandidate], referer: pageUrl, userAgent: "fake-agent/1.0", pageTitle: "Example Live Stream" };
        },
      }),
    );
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-drm", filename: "x.ts" }),
      });
      assert.equal(downloadRes.status, 422);
    } finally {
      await close();
    }
  });
});

test("marks the job as failed and emits an error event when the download throws", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async () => {
          throw new Error("network exploded");
        },
      }),
    );
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "x.ts" }),
      });
      const { id: jobId } = (await downloadRes.json()) as { id: string };

      const events = await readSse(baseUrl, `/api/downloads/${jobId}/events`, 1);
      assert.equal(events[0]?.type, "error");

      const listRes = await fetch(`${baseUrl}/api/downloads`);
      const jobs = (await listRes.json()) as Array<{ id: string; status: string }>;
      assert.equal(jobs.find((j) => j.id === jobId)?.status, "failed");
    } finally {
      await close();
    }
  });
});

test("downloads into a nested destinationFolder (ADR-0008) and records it on the job", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          detectionId,
          candidateId: "candidate-1",
          filename: "video.ts",
          destinationFolder: "電影/2024",
        }),
      });
      assert.equal(downloadRes.status, 202);
      const { id: jobId } = (await downloadRes.json()) as { id: string };
      await readSse(baseUrl, `/api/downloads/${jobId}/events`, 3);

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{
        id: string;
        destinationFolder: string;
        outputPath: string;
      }>;
      const job = jobs.find((j) => j.id === jobId)!;
      assert.equal(job.destinationFolder, "電影/2024");
      assert.equal(job.outputPath, join(dirs.downloadsDir, "電影", "2024", "video.ts"));
      assert.equal(await readFile(job.outputPath, "utf8"), "fake-video-bytes");
    } finally {
      await close();
    }
  });
});

test("filename conflict check is scoped per destination folder — same name in different folders doesn't conflict", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const firstRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "dup.ts", destinationFolder: "電影" }),
      });
      assert.equal(firstRes.status, 202);
      const { id: firstJobId } = (await firstRes.json()) as { id: string };
      await readSse(baseUrl, `/api/downloads/${firstJobId}/events`, 3);

      const secondRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "dup.ts", destinationFolder: "影集" }),
      });
      assert.equal(secondRes.status, 202, "same filename in a different destination folder must not conflict");
    } finally {
      await close();
    }
  });
});

test("rejects a destinationFolder that attempts path traversal with 400", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          detectionId,
          candidateId: "candidate-1",
          filename: "x.ts",
          destinationFolder: "../../etc",
        }),
      });
      assert.equal(downloadRes.status, 400);
    } finally {
      await close();
    }
  });
});

test("GET /api/folders lists immediate subfolders of a path, and 404s for a path that doesn't exist", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      await mkdir(join(dirs.downloadsDir, "電影"), { recursive: true });
      await mkdir(join(dirs.downloadsDir, "影集"), { recursive: true });
      await writeFile(join(dirs.downloadsDir, "not-a-folder.txt"), "x");
      await mkdir(join(dirs.downloadsDir, "電影", "2024"), { recursive: true });

      const rootRes = await fetch(`${baseUrl}/api/folders`);
      assert.equal(rootRes.status, 200);
      assert.deepEqual((await rootRes.json()).folders, ["電影", "影集"]);

      const nestedRes = await fetch(`${baseUrl}/api/folders?path=${encodeURIComponent("電影")}`);
      assert.equal(nestedRes.status, 200);
      assert.deepEqual((await nestedRes.json()).folders, ["2024"]);

      const missingRes = await fetch(`${baseUrl}/api/folders?path=${encodeURIComponent("不存在")}`);
      assert.equal(missingRes.status, 404);
    } finally {
      await close();
    }
  });
});

test("GET /api/settings defaults to a concurrency limit of 3, PUT updates it, and rejects invalid values (ADR-0009)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const defaults = {
        concurrencyLimit: 3,
        transcodeEnabled: false,
        transcodeConcurrencyLimit: 1,
        suggestedFilenameMaxLength: 80,
      };
      const defaultRes = await fetch(`${baseUrl}/api/settings`);
      assert.equal(defaultRes.status, 200);
      assert.deepEqual(await defaultRes.json(), defaults);

      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 7 }),
      });
      assert.equal(putRes.status, 200);
      assert.deepEqual(await putRes.json(), { ...defaults, concurrencyLimit: 7 });
      assert.deepEqual(await (await fetch(`${baseUrl}/api/settings`)).json(), { ...defaults, concurrencyLimit: 7 });

      const invalidRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 0 }),
      });
      assert.equal(invalidRes.status, 400);
      assert.deepEqual(
        await (await fetch(`${baseUrl}/api/settings`)).json(),
        { ...defaults, concurrencyLimit: 7 },
        "a rejected update must not overwrite the previously valid setting",
      );
    } finally {
      await close();
    }
  });
});

test("PUT /api/settings updates transcodeEnabled and transcodeConcurrencyLimit independently of concurrencyLimit (ADR-0012, ADR-0013)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcodeEnabled: true, transcodeConcurrencyLimit: 2 }),
      });
      assert.equal(putRes.status, 200);
      assert.deepEqual(await putRes.json(), {
        concurrencyLimit: 3,
        transcodeEnabled: true,
        transcodeConcurrencyLimit: 2,
        suggestedFilenameMaxLength: 80,
      });

      const invalidRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcodeConcurrencyLimit: 0 }),
      });
      assert.equal(invalidRes.status, 400);
      assert.deepEqual(await (await fetch(`${baseUrl}/api/settings`)).json(), {
        concurrencyLimit: 3,
        transcodeEnabled: true,
        transcodeConcurrencyLimit: 2,
        suggestedFilenameMaxLength: 80,
      });
    } finally {
      await close();
    }
  });
});

test("PUT /api/settings accepts null for suggestedFilenameMaxLength (no cap) and rejects values below 10 (ADR-0014)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const put = (body: unknown) =>
        fetch(`${baseUrl}/api/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const okRes = await put({ suggestedFilenameMaxLength: 40 });
      assert.equal((await okRes.json()).suggestedFilenameMaxLength, 40);

      const offRes = await put({ suggestedFilenameMaxLength: null });
      assert.equal(offRes.status, 200);
      assert.equal((await offRes.json()).suggestedFilenameMaxLength, null, "null means no cap");

      const tooSmallRes = await put({ suggestedFilenameMaxLength: 5 });
      assert.equal(tooSmallRes.status, 400);
      assert.equal(
        (await (await fetch(`${baseUrl}/api/settings`)).json()).suggestedFilenameMaxLength,
        null,
        "a rejected update must not overwrite the previous value",
      );
    } finally {
      await close();
    }
  });
});

test("an over-long typed filename is silently truncated to <= 200 bytes, keeping the extension and not splitting a character (ADR-0014)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const longName = `${"中".repeat(300)}.ts`;
      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: longName }),
      });
      assert.equal(downloadRes.status, 202);

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ filename: string }>;
      const { filename } = jobs[0]!;
      assert.ok(Buffer.byteLength(filename, "utf8") <= 200, `filename is ${Buffer.byteLength(filename, "utf8")} bytes`);
      assert.ok(filename.endsWith(".ts"), "the extension survives truncation");
      assert.ok(!filename.includes("�"), "no character was split mid-sequence");
      assert.ok(/^中+\.ts$/.test(filename), "only the trailing overflow was trimmed");
    } finally {
      await close();
    }
  });
});

test("queues a download once the concurrency limit is reached, and starts it once a slot frees up (ADR-0009)", async () => {
  await withTempDirs(async (dirs) => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async (_segments, outputPath, _options, onProgress) => {
          started++;
          if (started === 1) await firstGate;
          onProgress?.({ completedSegments: 1, totalSegments: 1 });
          await writeFile(outputPath, `bytes-${started}`);
        },
      }),
    );
    try {
      const putRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 1 }),
      });
      assert.equal(putRes.status, 200);

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const firstRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "a.ts" }),
      });
      const { id: firstJobId, status: firstStatus } = (await firstRes.json()) as { id: string; status: string };
      assert.equal(firstStatus, "pending", "with a free slot the first job should start right away");

      const secondRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "b.ts" }),
      });
      const {
        id: secondJobId,
        status: secondStatus,
        queuePosition,
      } = (await secondRes.json()) as { id: string; status: string; queuePosition: number };
      assert.equal(secondStatus, "queued", "with the limit already held, the second job should wait in the Queue");
      assert.equal(queuePosition, 1, "it's the only job waiting, so it's first in line");

      const jobsWhileWaiting = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.equal(jobsWhileWaiting.find((j) => j.id === secondJobId)?.status, "queued");
      assert.equal(started, 1, "the queued job's downloadToFile must not have been invoked yet");

      releaseFirst();
      await readSse(baseUrl, `/api/downloads/${firstJobId}/events`, 3);
      await readSse(baseUrl, `/api/downloads/${secondJobId}/events`, 3);

      const jobsAfter = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.equal(jobsAfter.find((j) => j.id === firstJobId)?.status, "completed");
      assert.equal(jobsAfter.find((j) => j.id === secondJobId)?.status, "completed");
      assert.equal(started, 2, "the second job should have started once the first freed its slot");
    } finally {
      await close();
    }
  });
});

test("raising the concurrency limit immediately promotes a waiting queued job (ADR-0009)", async () => {
  await withTempDirs(async (dirs) => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async (_segments, outputPath, _options, onProgress) => {
          started++;
          if (started === 1) await firstGate;
          onProgress?.({ completedSegments: 1, totalSegments: 1 });
          await writeFile(outputPath, `bytes-${started}`);
        },
      }),
    );
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 1 }),
      });

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "a.ts" }),
      });
      const secondRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "b.ts" }),
      });
      const { id: secondJobId } = (await secondRes.json()) as { id: string };
      assert.equal(started, 1, "the second job should still be waiting, first job's gate not yet released");

      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 2 }),
      });

      // both jobs now hold a slot: the still-gated first, and the newly-promoted second (which,
      // unblocked from the start, may already have raced ahead to "downloading").
      const jobsAfterRaise = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.notEqual(jobsAfterRaise.find((j) => j.id === secondJobId)?.status, "queued");

      releaseFirst();
      await readSse(baseUrl, `/api/downloads/${secondJobId}/events`, 3);
      const jobsAfter = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.equal(jobsAfter.find((j) => j.id === secondJobId)?.status, "completed");
    } finally {
      await close();
    }
  });
});

test("DELETE /api/downloads/:id cancels a queued job, refuses an active one, and 404s for an unknown id", async () => {
  await withTempDirs(async (dirs) => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async (_segments, outputPath, _options, onProgress) => {
          started++;
          if (started === 1) await firstGate;
          onProgress?.({ completedSegments: 1, totalSegments: 1 });
          await writeFile(outputPath, `bytes-${started}`);
        },
      }),
    );
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 1 }),
      });

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const firstRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "a.ts" }),
      });
      const { id: firstJobId } = (await firstRes.json()) as { id: string };

      const secondRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "b.ts" }),
      });
      const { id: secondJobId } = (await secondRes.json()) as { id: string };

      const activeCancelRes = await fetch(`${baseUrl}/api/downloads/${firstJobId}`, { method: "DELETE" });
      assert.equal(activeCancelRes.status, 409, "a job already holding an execution slot cannot be cancelled");

      const missingCancelRes = await fetch(`${baseUrl}/api/downloads/does-not-exist`, { method: "DELETE" });
      assert.equal(missingCancelRes.status, 404);

      const queuedCancelRes = await fetch(`${baseUrl}/api/downloads/${secondJobId}`, { method: "DELETE" });
      assert.equal(queuedCancelRes.status, 200);

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.equal(jobs.find((j) => j.id === secondJobId)?.status, "cancelled");

      releaseFirst();
      await readSse(baseUrl, `/api/downloads/${firstJobId}/events`, 3);
      assert.equal(started, 1, "cancelling the queued job must not have started it");
    } finally {
      await close();
    }
  });
});

test("DELETE /api/downloads/:id deletes a completed or failed job's history record, without touching the file (ADR-0010)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async (_segments, outputPath, _options, onProgress) => {
          if (outputPath.endsWith("boom.ts")) throw new Error("network exploded");
          onProgress?.({ completedSegments: 1, totalSegments: 1 });
          await writeFile(outputPath, "fake-video-bytes");
        },
      }),
    );
    try {
      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const completedRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "ok.ts" }),
      });
      const { id: completedJobId } = (await completedRes.json()) as { id: string };
      await readSse(baseUrl, `/api/downloads/${completedJobId}/events`, 3);

      const failedRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "boom.ts" }),
      });
      const { id: failedJobId } = (await failedRes.json()) as { id: string };
      await readSse(baseUrl, `/api/downloads/${failedJobId}/events`, 1);

      const deleteCompletedRes = await fetch(`${baseUrl}/api/downloads/${completedJobId}`, { method: "DELETE" });
      assert.equal(deleteCompletedRes.status, 200);
      const deleteFailedRes = await fetch(`${baseUrl}/api/downloads/${failedJobId}`, { method: "DELETE" });
      assert.equal(deleteFailedRes.status, 200);

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string }>;
      assert.equal(jobs.find((j) => j.id === completedJobId), undefined, "the record is gone");
      assert.equal(jobs.find((j) => j.id === failedJobId), undefined, "the record is gone");

      // the file on disk is untouched (ADR-0010) even though its history record is gone
      assert.equal(await readFile(join(dirs.downloadsDir, "ok.ts"), "utf8"), "fake-video-bytes");

      const redeleteRes = await fetch(`${baseUrl}/api/downloads/${completedJobId}`, { method: "DELETE" });
      assert.equal(redeleteRes.status, 404, "deleting an already-deleted record is unknown, not a conflict");
    } finally {
      await close();
    }
  });
});

test("queue positions shift down for jobs behind one that gets cancelled (ADR-0009)", async () => {
  await withTempDirs(async (dirs) => {
    const neverResolves = new Promise<void>(() => {});
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        downloadToFile: async (_segments, outputPath, _options, onProgress) => {
          onProgress?.({ completedSegments: 1, totalSegments: 1 });
          await writeFile(outputPath, "bytes-1");
          await neverResolves; // keep the only slot held so the queue never drains on its own
        },
      }),
    );
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: 1 }),
      });

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const postDownload = (filename: string) =>
        fetch(`${baseUrl}/api/downloads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename }),
        }).then((res) => res.json() as Promise<{ id: string; status: string; queuePosition?: number }>);

      await postDownload("a.ts"); // holds the only slot
      const second = await postDownload("b.ts");
      const third = await postDownload("c.ts");
      assert.equal(second.queuePosition, 1);
      assert.equal(third.queuePosition, 2);

      const thirdEventsPromise = readSse(baseUrl, `/api/downloads/${third.id}/events`, 1);
      const cancelRes = await fetch(`${baseUrl}/api/downloads/${second.id}`, { method: "DELETE" });
      assert.equal(cancelRes.status, 200);

      const thirdEvents = await thirdEventsPromise;
      assert.equal(thirdEvents[0]?.type, "queued");
      assert.equal((thirdEvents[0]?.data as { position: number }).position, 1, "moved up now that job b was cancelled");
    } finally {
      await close();
    }
  });
});

test("a transcodeEnabled download forces a .mkv filename and runs through transcoding before completing (ADR-0012)", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcodeEnabled: true }),
      });

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const downloadRes = await fetch(`${baseUrl}/api/downloads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename: "my video.ts" }),
      });
      assert.equal(downloadRes.status, 202);
      const { id: jobId } = (await downloadRes.json()) as { id: string };

      // "transcoding" fires twice: once immediately on acquiring the slot, once from the fake
      // ffmpeg's own progress tick.
      const events = await readSse(baseUrl, `/api/downloads/${jobId}/events`, 5);
      assert.deepEqual(events.map((e) => e.type), ["progress", "transcoding", "transcoding", "moving", "done"]);

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{
        id: string;
        status: string;
        filename: string;
        transcodeEnabled: boolean;
        outputPath: string;
      }>;
      const job = jobs.find((j) => j.id === jobId)!;
      assert.equal(job.status, "completed");
      assert.equal(job.filename, "my video.mkv", "the .ts extension the user typed is forced to .mkv (Q9)");
      assert.equal(job.transcodeEnabled, true);
      assert.equal(job.outputPath, join(dirs.downloadsDir, "my video.mkv"));

      // the pre-transcode raw file and the whole cache dir are both cleaned up (Q5)
      await assert.rejects(access(join(dirs.cacheDir, jobId)));
    } finally {
      await close();
    }
  });
});

test("waits in the Transcode Queue when the transcode concurrency limit is reached, then promotes (ADR-0013)", async () => {
  await withTempDirs(async (dirs) => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let transcodeStarted = 0;
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        transcode: (inputPath, outputPath, totalDurationSeconds, onProgress) => {
          transcodeStarted++;
          const startedAt = transcodeStarted;
          const done = (async () => {
            if (startedAt === 1) await firstGate;
            onProgress?.({ encodedSeconds: totalDurationSeconds, totalSeconds: totalDurationSeconds });
            await copyFile(inputPath, outputPath);
          })();
          return { done, cancel: () => {} };
        },
      }),
    );
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcodeEnabled: true, transcodeConcurrencyLimit: 1 }),
      });

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const postDownload = (filename: string) =>
        fetch(`${baseUrl}/api/downloads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename }),
        }).then((res) => res.json() as Promise<{ id: string }>);

      const first = await postDownload("a.ts");
      const second = await postDownload("b.ts");

      // first job reaches transcoding and holds the only transcode slot (gated); second waits behind it
      await readSse(baseUrl, `/api/downloads/${first.id}/events`, 2); // progress, transcoding
      const secondEvents = await readSse(baseUrl, `/api/downloads/${second.id}/events`, 2); // progress, transcodeQueued
      assert.equal(secondEvents[1]?.type, "transcodeQueued");
      assert.equal((secondEvents[1]?.data as { position: number }).position, 1);
      assert.equal(transcodeStarted, 1, "the transcode-queued job's ffmpeg must not have been invoked yet");

      releaseFirst();
      // "transcoding" fires twice per job: once on acquiring the slot, once from the fake
      // ffmpeg's own progress tick.
      await readSse(baseUrl, `/api/downloads/${first.id}/events`, 5); // progress, transcoding x2, moving, done
      await readSse(baseUrl, `/api/downloads/${second.id}/events`, 6); // progress, transcodeQueued, transcoding x2, moving, done

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.equal(jobs.find((j) => j.id === first.id)?.status, "completed");
      assert.equal(jobs.find((j) => j.id === second.id)?.status, "completed");
      assert.equal(transcodeStarted, 2, "the second job's ffmpeg should have started once the first freed its slot");
    } finally {
      await close();
    }
  });
});

test("DELETE cancels a job waiting in the Transcode Queue, and a job actively transcoding by killing its ffmpeg process (ADR-0013)", async () => {
  await withTempDirs(async (dirs) => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let cancelCalls = 0;
    const { baseUrl, close } = await startApp(
      makeDeps(dirs, {
        transcode: (inputPath, outputPath, totalDurationSeconds, onProgress) => {
          let cancelled = false;
          const done = (async () => {
            await firstGate;
            if (cancelled) throw new Error("killed by SIGTERM");
            onProgress?.({ encodedSeconds: totalDurationSeconds, totalSeconds: totalDurationSeconds });
            await copyFile(inputPath, outputPath);
          })();
          return {
            done,
            cancel: () => {
              cancelled = true;
              cancelCalls++;
              releaseFirst(); // simulate the killed process's stream ending
            },
          };
        },
      }),
    );
    try {
      await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcodeEnabled: true, transcodeConcurrencyLimit: 1 }),
      });

      const detectRes = await fetch(`${baseUrl}/api/detections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageUrl: "https://example.com/page" }),
      });
      const { id: detectionId } = (await detectRes.json()) as { id: string };
      await readSse(baseUrl, `/api/detections/${detectionId}/events`, 2);

      const postDownload = (filename: string) =>
        fetch(`${baseUrl}/api/downloads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ detectionId, candidateId: "candidate-1", filename }),
        }).then((res) => res.json() as Promise<{ id: string }>);

      const first = await postDownload("a.ts");
      const second = await postDownload("b.ts");

      await readSse(baseUrl, `/api/downloads/${first.id}/events`, 2); // progress, transcoding — holds the only (gated) slot
      const secondEvents = await readSse(baseUrl, `/api/downloads/${second.id}/events`, 2); // progress, transcodeQueued
      assert.equal(secondEvents[1]?.type, "transcodeQueued");

      const cancelQueuedRes = await fetch(`${baseUrl}/api/downloads/${second.id}`, { method: "DELETE" });
      assert.equal(cancelQueuedRes.status, 200);
      assert.equal(cancelCalls, 0, "a job still waiting in the Transcode Queue never held an ffmpeg process to kill");

      const cancelActiveRes = await fetch(`${baseUrl}/api/downloads/${first.id}`, { method: "DELETE" });
      assert.equal(cancelActiveRes.status, 200);
      assert.equal(cancelCalls, 1, "the running ffmpeg process was killed");

      const jobs = (await (await fetch(`${baseUrl}/api/downloads`)).json()) as Array<{ id: string; status: string }>;
      assert.equal(jobs.find((j) => j.id === first.id)?.status, "cancelled");
      assert.equal(jobs.find((j) => j.id === second.id)?.status, "cancelled");
    } finally {
      await close();
    }
  });
});

test("POST /api/folders creates a new subfolder, rejecting names with a path separator", async () => {
  await withTempDirs(async (dirs) => {
    const { baseUrl, close } = await startApp(makeDeps(dirs));
    try {
      const createRes = await fetch(`${baseUrl}/api/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "電影", name: "2024" }),
      });
      assert.equal(createRes.status, 201);
      assert.equal((await createRes.json()).path, "電影/2024");
      await access(join(dirs.downloadsDir, "電影", "2024"));

      const invalidRes = await fetch(`${baseUrl}/api/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "", name: "a/b" }),
      });
      assert.equal(invalidRes.status, 400);
    } finally {
      await close();
    }
  });
});
