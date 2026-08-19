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

test("create() defaults transcodeEnabled to false when omitted, and persists it when set (ADR-0012)", () => {
  const store = makeStore();

  const withoutFlag = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });
  assert.equal(withoutFlag.transcodeEnabled, false);

  const withFlag = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  assert.equal(withFlag.transcodeEnabled, true);
  assert.equal(store.get(withFlag.id)!.transcodeEnabled, true);
});

test("create() defaults to pending when initialStatus is omitted", () => {
  const store = makeStore();

  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  assert.equal(job.status, "pending");
});

test("create() honors initialStatus: queued (ADR-0009)", () => {
  const store = makeStore();

  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
    initialStatus: "queued",
  });

  assert.equal(job.status, "queued");
  assert.equal(store.get(job.id)!.status, "queued");
});

test("markPending() promotes a queued job to pending", () => {
  const store = makeStore();
  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
    initialStatus: "queued",
  });

  store.markPending(job.id);

  assert.equal(store.get(job.id)!.status, "pending");
});

test("cancel() cancels a queued job and reports success", () => {
  const store = makeStore();
  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
    initialStatus: "queued",
  });

  const cancelled = store.cancel(job.id);

  assert.equal(cancelled, true);
  assert.equal(store.get(job.id)!.status, "cancelled");
});

test("cancel() no-ops once a job has left queued, reporting failure", () => {
  const store = makeStore();
  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });

  const cancelled = store.cancel(job.id);

  assert.equal(cancelled, false);
  assert.equal(store.get(job.id)!.status, "pending");
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

test("updateTranscodeProgress() records progress under status transcoding, not downloading", () => {
  const store = makeStore();
  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  store.markTranscoding(job.id);

  store.updateTranscodeProgress(job.id, 0.5);
  const fetched = store.get(job.id)!;

  assert.equal(fetched.status, "transcoding");
  assert.equal(fetched.progress, 0.5);
});

test("markTranscodeQueued() then markTranscoding() move status through the Transcode Queue (ADR-0013)", () => {
  const store = makeStore();
  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });

  store.markTranscodeQueued(job.id);
  assert.equal(store.get(job.id)!.status, "transcodeQueued");

  store.markTranscoding(job.id);
  assert.equal(store.get(job.id)!.status, "transcoding");
});

test("cancelTranscode() cancels a job in transcodeQueued or transcoding, and no-ops otherwise (ADR-0013)", () => {
  const store = makeStore();
  const queued = store.create({
    sourcePageUrl: "https://example.com/a",
    candidateUrl: "https://example.com/a.m3u8",
    filename: "a.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  store.markTranscodeQueued(queued.id);
  assert.equal(store.cancelTranscode(queued.id), true);
  assert.equal(store.get(queued.id)!.status, "cancelled");

  const transcoding = store.create({
    sourcePageUrl: "https://example.com/b",
    candidateUrl: "https://example.com/b.m3u8",
    filename: "b.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  store.markTranscoding(transcoding.id);
  assert.equal(store.cancelTranscode(transcoding.id), true);
  assert.equal(store.get(transcoding.id)!.status, "cancelled");

  const pending = store.create({
    sourcePageUrl: "https://example.com/c",
    candidateUrl: "https://example.com/c.m3u8",
    filename: "c.ts",
    destinationFolder: "",
  });
  assert.equal(store.cancelTranscode(pending.id), false);
  assert.equal(store.get(pending.id)!.status, "pending");
});

test("countActiveTranscode(), nextTranscodeQueued(), and listTranscodeQueued() track the Transcode Queue (ADR-0013)", () => {
  const store = makeStore();
  const first = store.create({
    sourcePageUrl: "https://example.com/a",
    candidateUrl: "https://example.com/a.m3u8",
    filename: "a.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  const second = store.create({
    sourcePageUrl: "https://example.com/b",
    candidateUrl: "https://example.com/b.m3u8",
    filename: "b.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  store.markTranscodeQueued(first.id);
  store.markTranscodeQueued(second.id);

  assert.equal(store.countActiveTranscode(), 0, "transcodeQueued jobs don't hold a slot");
  assert.equal(store.nextTranscodeQueued()!.id, first.id, "oldest first");
  assert.deepEqual(
    store.listTranscodeQueued().map((j) => j.id),
    [first.id, second.id],
  );

  store.markTranscoding(first.id);
  assert.equal(store.countActiveTranscode(), 1, "transcoding jobs hold a slot");
  assert.equal(store.nextTranscodeQueued()!.id, second.id);
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

test("failAllInProgress() leaves queued and transcodeQueued jobs untouched (ADR-0009, ADR-0013)", () => {
  const store = makeStore();
  const queued = store.create({
    sourcePageUrl: "https://example.com/a",
    candidateUrl: "https://example.com/a.m3u8",
    filename: "a.ts",
    destinationFolder: "",
    initialStatus: "queued",
  });
  const transcodeQueued = store.create({
    sourcePageUrl: "https://example.com/e",
    candidateUrl: "https://example.com/e.m3u8",
    filename: "e.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  store.markTranscodeQueued(transcodeQueued.id);

  store.failAllInProgress("interrupted by server restart");

  assert.equal(store.get(queued.id)!.status, "queued");
  assert.equal(store.get(transcodeQueued.id)!.status, "transcodeQueued");
});

test("failAllInProgress() marks pending, downloading, transcoding, and moving jobs as failed, leaving completed/failed jobs untouched", () => {
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
  const transcoding = store.create({
    sourcePageUrl: "https://example.com/e",
    candidateUrl: "https://example.com/e.m3u8",
    filename: "e.mkv",
    destinationFolder: "",
    transcodeEnabled: true,
  });
  store.markTranscoding(transcoding.id);
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
  assert.equal(store.get(transcoding.id)!.status, "failed");
  assert.equal(store.get(moving.id)!.status, "failed");
  assert.equal(store.get(completed.id)!.status, "completed");
});

test("remove() deletes a completed job's record and reports success (ADR-0010)", () => {
  const store = makeStore();
  const job = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });
  store.markCompleted(job.id, "/downloads/my-video.ts");

  const removed = store.remove(job.id);

  assert.equal(removed, true);
  assert.equal(store.get(job.id), undefined);
});

test("remove() deletes a failed or cancelled job's record too", () => {
  const store = makeStore();
  const failed = store.create({
    sourcePageUrl: "https://example.com/a",
    candidateUrl: "https://example.com/a.m3u8",
    filename: "a.ts",
    destinationFolder: "",
  });
  store.markFailed(failed.id, "connection reset");
  const cancelled = store.create({
    sourcePageUrl: "https://example.com/b",
    candidateUrl: "https://example.com/b.m3u8",
    filename: "b.ts",
    destinationFolder: "",
    initialStatus: "queued",
  });
  store.cancel(cancelled.id);

  assert.equal(store.remove(failed.id), true);
  assert.equal(store.remove(cancelled.id), true);
  assert.equal(store.get(failed.id), undefined);
  assert.equal(store.get(cancelled.id), undefined);
});

test("remove() no-ops for a job still holding an execution slot, and for an unknown id", () => {
  const store = makeStore();
  const pending = store.create({
    sourcePageUrl: "https://example.com/live",
    candidateUrl: "https://example.com/live/hi/index.m3u8",
    filename: "my-video.ts",
    destinationFolder: "",
  });
  const queued = store.create({
    sourcePageUrl: "https://example.com/live2",
    candidateUrl: "https://example.com/live2/hi/index.m3u8",
    filename: "other-video.ts",
    destinationFolder: "",
    initialStatus: "queued",
  });

  assert.equal(store.remove(pending.id), false);
  assert.equal(store.remove(queued.id), false, "a queued job is cancelled, not deleted");
  assert.equal(store.remove("does-not-exist"), false);
  assert.equal(store.get(pending.id)!.status, "pending");
  assert.equal(store.get(queued.id)!.status, "queued");
});
