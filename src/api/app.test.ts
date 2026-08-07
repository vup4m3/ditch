import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type AppDependencies } from "./app.ts";
import { JobStore } from "../db/jobStore.ts";
import type { Candidate } from "../detection/types.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ditch-app-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

function makeDeps(downloadsDir: string, overrides: Partial<AppDependencies> = {}): AppDependencies {
  const jobStore = new JobStore(new DatabaseSync(":memory:"));
  return {
    jobStore,
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
    ...overrides,
  };
}

test("full happy path: detect, list candidate, download, see it complete, fetch the file", async () => {
  await withTempDir(async (downloadsDir) => {
    const { baseUrl, close } = await startApp(makeDeps(downloadsDir));
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

      const downloadEvents = await readSse(baseUrl, `/api/downloads/${jobId}/events`, 2);
      assert.equal(downloadEvents[0]?.type, "progress");
      assert.equal(downloadEvents[1]?.type, "done");

      const listRes = await fetch(`${baseUrl}/api/downloads`);
      const jobs = (await listRes.json()) as Array<{ id: string; status: string; filename: string }>;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.id, jobId);
      assert.equal(jobs[0]?.status, "completed");
      assert.equal(jobs[0]?.filename, "my video.ts");

      const fileRes = await fetch(`${baseUrl}/api/downloads/${jobId}/file`);
      assert.equal(fileRes.status, 200);
      assert.equal(await fileRes.text(), "fake-video-bytes");
    } finally {
      await close();
    }
  });
});

test("rejects a download request for a DRM-protected candidate with 422", async () => {
  await withTempDir(async (downloadsDir) => {
    const drmCandidate: Candidate = { ...CANDIDATE, id: "candidate-drm", drmProtected: true };
    const { baseUrl, close } = await startApp(
      makeDeps(downloadsDir, {
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
  await withTempDir(async (downloadsDir) => {
    const { baseUrl, close } = await startApp(
      makeDeps(downloadsDir, {
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
