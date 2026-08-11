export type JobStatus = "pending" | "downloading" | "moving" | "completed" | "failed";

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
}
