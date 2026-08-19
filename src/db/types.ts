// "queued" and "cancelled" support the concurrency limit (ADR-0009): a job waits as "queued"
// until it holds an execution slot, then proceeds as normal; only a "queued" job can be cancelled.
// "transcodeQueued" and "transcoding" are the Transcode equivalents (ADR-0012/0013), sitting
// between "downloading" and "moving" — skipped entirely when the job's transcodeEnabled is false.
export type JobStatus =
  | "queued"
  | "pending"
  | "downloading"
  | "transcodeQueued"
  | "transcoding"
  | "moving"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadJobRecord {
  id: string;
  sourcePageUrl: string;
  candidateUrl: string;
  filename: string;
  /** Relative path under DOWNLOADS_DIR the file was saved into; "" means the root (see ADR-0008). */
  destinationFolder: string;
  status: JobStatus;
  progress: number;
  errorMessage: string | null;
  outputPath: string | null;
  /**
   * Whether this job transcodes to MKV/AV1 (ADR-0012) — frozen from the global Settings toggle
   * at job creation, so changing the setting later never changes an already-created job's behavior.
   */
  transcodeEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobInput {
  sourcePageUrl: string;
  candidateUrl: string;
  filename: string;
  destinationFolder: string;
  /** Whether the job starts holding an execution slot right away or waits in the Queue for one (ADR-0009). Defaults to "pending". */
  initialStatus?: "queued" | "pending";
  /** Frozen from the global Settings toggle at creation (ADR-0012). Defaults to false. */
  transcodeEnabled?: boolean;
}
