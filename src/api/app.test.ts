import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type AppDependencies } from "./app.ts";
import { JobStore } from "../db/jobStore.ts";
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
  const jobStore = new JobStore(new DatabaseSync(":memory:"));
  return {
    jobStore,
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
