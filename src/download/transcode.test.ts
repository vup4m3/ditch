import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcodeToMkvAv1 } from "./transcode.ts";

const execFileAsync = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ditch-transcode-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A tiny synthetic clip (h264 video + aac audio, no network/fixture files needed). */
function makeTestClip(outputPath: string, durationSeconds: number, size = "64x64"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc=duration=${durationSeconds}:size=${size}:rate=30`,
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=8000:cl=mono`,
        "-t",
        String(durationSeconds),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        outputPath,
      ],
      { stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg fixture exited ${code}`))));
  });
}

async function probeStreams(path: string): Promise<Array<{ codec_type: string; codec_name: string }>> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", path]);
  return (JSON.parse(stdout).streams as Array<{ codec_type: string; codec_name: string }>) ?? [];
}

test("transcodeToMkvAv1() re-encodes video to AV1, copies audio as-is, and reports progress", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mkv");
    await makeTestClip(input, 2);

    const progressEvents: Array<{ encodedSeconds: number; totalSeconds: number }> = [];
    const handle = transcodeToMkvAv1(input, output, 2, (p) => progressEvents.push(p));
    await handle.done;

    const streams = await probeStreams(output);
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    assert.equal(video?.codec_name, "av1");
    assert.equal(audio?.codec_name, "aac", "audio is stream-copied, not re-encoded");

    assert.ok(progressEvents.length > 0, "at least one progress event should have fired");
    assert.ok(progressEvents.every((p) => p.totalSeconds === 2));
    assert.ok(progressEvents.at(-1)!.encodedSeconds > 0);
  });
});

test("transcodeToMkvAv1() rejects with ffmpeg's error output when the input doesn't exist", async () => {
  await withTempDir(async (dir) => {
    const handle = transcodeToMkvAv1(join(dir, "does-not-exist.mp4"), join(dir, "output.mkv"), 0);
    await assert.rejects(handle.done, /ffmpeg exited with code/);
    await assert.rejects(access(join(dir, "output.mkv")));
  });
});

test("cancel() terminates ffmpeg mid-encode and done rejects", async () => {
  await withTempDir(async (dir) => {
    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mkv");
    // 720p/30s takes ~2s to encode with our settings — long enough to still be running
    // when we cancel a few hundred ms in, unlike the tiny 64x64 clips the other tests use.
    await makeTestClip(input, 30, "1280x720");

    const handle = transcodeToMkvAv1(input, output, 30);
    await new Promise((r) => setTimeout(r, 300));
    handle.cancel();

    await assert.rejects(handle.done);
  });
});
