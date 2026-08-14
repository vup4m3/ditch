// "queued" and "cancelled" support the concurrency limit (ADR-0009): a job waits as "queued"
// until it holds an execution slot, then proceeds as normal; only a "queued" job can be cancelled.
export type JobStatus = "queued" | "pending" | "downloading" | "moving" | "completed" | "failed" | "cancelled";

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
}
