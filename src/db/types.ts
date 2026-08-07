export type JobStatus = "pending" | "downloading" | "completed" | "failed";

export interface DownloadJobRecord {
  id: string;
  sourcePageUrl: string;
  candidateUrl: string;
  filename: string;
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
}
