import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { JobStore } from "./jobStore.ts";

function makeStore(): JobStore {
  const db = new DatabaseSync(":memory:");
  return new JobStore(db);
}

test("create() inserts a pending job with zero progress", () => {
  const store = makeStore();

  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  assert.equal(job.status, "pending");
  assert.equal(job.progress, 0);
  assert.equal(job.sourcePageUrl, "https://example.com/live");
  assert.equal(job.candidateUrl, "https://example.com/live/hi/index.m3u8");
  assert.equal(job.filename, "my-video.ts");
  assert.equal(job.destinationFolder, "");
  assert.equal(job.errorMessage, null);
  assert.equal(job.outputPath, null);
  assert.ok(job.id);
});

test("create() persists a nested destinationFolder (ADR-0008)", () => {
  const store = makeStore();

  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "電影/2024",
  });

  assert.equal(job.destinationFolder, "電影/2024");
  assert.equal(store.get(job.id)!.destinationFolder, "電影/2024");
});

test("get() retrieves a previously created job by id", () => {
  const store = makeStore();
  const created = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  const fetched = store.get(created.id);

  assert.deepEqual(fetched, created);
});

test("get() returns undefined for an unknown id", () => {
  const store = makeStore();
  assert.equal(store.get("does-not-exist"), undefined);
});

test("updateProgress() moves status to downloading and records progress", () => {
  const store = makeStore();
  const created = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  store.updateProgress(created.id, 0.42);
  const fetched = store.get(created.id)!;

  assert.equal(fetched.status, "downloading");
  assert.equal(fetched.progress, 0.42);
});

test("markMoving() sets status to moving", () => {
  const store = makeStore();
  const created = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });
  store.updateProgress(created.id, 1);

  store.markMoving(created.id);
  const fetched = store.get(created.id)!;

  assert.equal(fetched.status, "moving");
});

test("markCompleted() sets status completed, progress 1, and the output path", () => {
  const store = makeStore();
  const created = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  store.markCompleted(created.id, "/downloads/my-video.ts");
  const fetched = store.get(created.id)!;

  assert.equal(fetched.status, "completed");
  assert.equal(fetched.progress, 1);
  assert.equal(fetched.outputPath, "/downloads/my-video.ts");
});

test("markFailed() sets status failed and records the error message", () => {
  const store = makeStore();
  const created = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  store.markFailed(created.id, "connection reset");
  const fetched = store.get(created.id)!;

  assert.equal(fetched.status, "failed");
  assert.equal(fetched.errorMessage, "connection reset");
});

test("list() returns jobs most-recently-created first", () => {
  const store = makeStore();
  const first = store.create({
    sourcePageUrl: "https://example.com/a",
    candidateUrl: "https://example.com/a.m3u8",
    filename: "a.ts",
    destinationFolder: "",
  });
  const second = store.create({
    sourcePageUrl: "https://example.com/b",
    candidateUrl: "https://example.com/b.m3u8",
    filename: "b.ts",
    destinationFolder: "",
  });

  const jobs = store.list();

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.id, second.id);
  assert.equal(jobs[1]!.id, first.id);
});

test("failAllInProgress() marks pending, downloading, and moving jobs as failed, leaving completed/failed jobs untouched", () => {
  const store = makeStore();
  const pending = store.create({
    sourcePageUrl: "https://example.com/a",
    candidateUrl: "https://example.com/a.m3u8",
    filename: "a.ts",
    destinationFolder: "",
  });
  const downloading = store.create({
    sourcePageUrl: "https://example.com/b",
    candidateUrl: "https://example.com/b.m3u8",
    filename: "b.ts",
    destinationFolder: "",
  });
  store.updateProgress(downloading.id, 0.5);
  const moving = store.create({
    sourcePageUrl: "https://example.com/d",
    candidateUrl: "https://example.com/d.m3u8",
    filename: "d.ts",
    destinationFolder: "",
  });
  store.markMoving(moving.id);
  const completed = store.create({
    sourcePageUrl: "https://example.com/c",
    candidateUrl: "https://example.com/c.m3u8",
    filename: "c.ts",
    destinationFolder: "",
  });
  store.markCompleted(completed.id, "/downloads/c.ts");

  store.failAllInProgress("interrupted by server restart");

  assert.equal(store.get(pending.id)!.status, "failed");
  assert.equal(store.get(pending.id)!.errorMessage, "interrupted by server restart");
  assert.equal(store.get(downloading.id)!.status, "failed");
  assert.equal(store.get(moving.id)!.status, "failed");
  assert.equal(store.get(completed.id)!.status, "completed");
});
