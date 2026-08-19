import { spawn } from "node:child_process";

export interface TranscodeProgress {
  /** Media time already encoded, in seconds. */
  encodedSeconds: number;
  /** Total media duration, in seconds; 0 when unknown (e.g. a "direct" Candidate with no manifest). */
  totalSeconds: number;
}

export interface TranscodeHandle {
  /** Resolves once ffmpeg exits 0, rejects otherwise (including on cancel()). */
  done: Promise<void>;
  /** Sends SIGTERM to the ffmpeg process (ADR-0013's cancel-mid-transcode support). */
  cancel: () => void;
}

// Fixed for the first version (ADR-0012) — no per-job quality/speed setting yet, and no
// detection of an already-AV1 source to skip re-encoding.
const LIBSVTAV1_PRESET = "8";
const LIBSVTAV1_CRF = "30";

function parseProgressLine(line: string, totalSeconds: number, onProgress: (p: TranscodeProgress) => void): void {
  // ffmpeg's `-progress pipe:1` emits `key=value` lines, one per line, ending each frame's
  // batch with `progress=continue` (or `progress=end` on the last one). `out_time_us` is the
  // encoded position in microseconds — the only field we need for a completed/total fraction.
  const match = /^out_time_us=(\d+)$/.exec(line.trim());
  if (!match) return;
  const encodedSeconds = Number(match[1]) / 1_000_000;
  onProgress({ encodedSeconds, totalSeconds });
}

/**
 * Re-encodes `inputPath`'s video track to AV1 (libsvtav1) into an MKV container at `outputPath`,
 * copying the audio track as-is (ADR-0012). `totalDurationSeconds` (sum of the job's
 * ManifestSegment durations; 0 for a "direct" Candidate with no manifest) drives progress
 * reporting — ffmpeg itself doesn't know the total up front.
 */
export function transcodeToMkvAv1(
  inputPath: string,
  outputPath: string,
  totalDurationSeconds: number,
  onProgress?: (progress: TranscodeProgress) => void,
): TranscodeHandle {
  const child = spawn(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libsvtav1",
      "-preset",
      LIBSVTAV1_PRESET,
      "-crf",
      LIBSVTAV1_CRF,
      "-c:a",
      "copy",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdoutBuffer = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (onProgress) parseProgressLine(line, totalDurationSeconds, onProgress);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr.trim()}`));
      }
    });
  });

  return { done, cancel: () => child.kill("SIGTERM") };
}
