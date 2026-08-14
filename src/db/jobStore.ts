import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { CreateJobInput, DownloadJobRecord, JobStatus } from "./types.ts";

interface Row {
  id: string;
  sourcePageUrl: string;
  candidateUrl: string;
  filename: string;
  destinationFolder: string;
  status: JobStatus;
  progress: number;
  errorMessage: string | null;
  outputPath: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToRecord(row: Row): DownloadJobRecord {
  return { ...row };
}

export class JobStore {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS download_jobs (
        id TEXT PRIMARY KEY,
        sourcePageUrl TEXT NOT NULL,
        candidateUrl TEXT NOT NULL,
        filename TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        errorMessage TEXT,
        outputPath TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    try {
      // Added for ADR-0008 (nested destination folders); pre-existing DB files won't have this
      // column yet. SQLite has no "ADD COLUMN IF NOT EXISTS", so ignore the "duplicate column" error.
      this.#db.exec(`ALTER TABLE download_jobs ADD COLUMN destinationFolder TEXT NOT NULL DEFAULT ''`);
    } catch {
      // column already exists
    }
  }

  create(input: CreateJobInput): DownloadJobRecord {
    const now = new Date().toISOString();
    const record: DownloadJobRecord = {
      id: randomUUID(),
      sourcePageUrl: input.sourcePageUrl,
      candidateUrl: input.candidateUrl,
      filename: input.filename,
      destinationFolder: input.destinationFolder,
      status: input.initialStatus ?? "pending",
      progress: 0,
      errorMessage: null,
      outputPath: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO download_jobs
          (id, sourcePageUrl, candidateUrl, filename, destinationFolder, status, progress, errorMessage, outputPath, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sourcePageUrl,
        record.candidateUrl,
        record.filename,
        record.destinationFolder,
        record.status,
        record.progress,
        record.errorMessage,
        record.outputPath,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  get(id: string): DownloadJobRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM download_jobs WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  updateProgress(id: string, progress: number): void {
    this.#db
      .prepare(`UPDATE download_jobs SET status = 'downloading', progress = ?, updatedAt = ? WHERE id = ?`)
      .run(progress, new Date().toISOString(), id);
  }

  /** Promotes a queued job to pending once it acquires an execution slot (ADR-0009). */
  markPending(id: string): void {
    this.#db
      .prepare(`UPDATE download_jobs SET status = 'pending', updatedAt = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /**
   * Cancels a job still waiting in the Queue. No-ops once the job holds an execution slot
   * (status is no longer "queued") — returns whether the cancellation actually applied (ADR-0009).
   */
  cancel(id: string): boolean {
    const result = this.#db
      .prepare(`UPDATE download_jobs SET status = 'cancelled', updatedAt = ? WHERE id = ? AND status = 'queued'`)
      .run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /**
   * Deletes a job's record entirely once it's reached a terminal state — completed, failed, or
   * cancelled (ADR-0010). Files already on disk (a completed download, a failed job's cache
   * leftovers) are untouched; this only clears the history entry. Returns whether it applied.
   */
  remove(id: string): boolean {
    const result = this.#db
      .prepare(`DELETE FROM download_jobs WHERE id = ? AND status IN ('completed', 'failed', 'cancelled')`)
      .run(id);
    return Number(result.changes) > 0;
  }

  /** Called once the file is fully written to cache and is being relocated to its final destination. */
  markMoving(id: string): void {
    this.#db
      .prepare(`UPDATE download_jobs SET status = 'moving', updatedAt = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  markCompleted(id: string, outputPath: string): void {
    this.#db
      .prepare(
        `UPDATE download_jobs SET status = 'completed', progress = 1, outputPath = ?, updatedAt = ? WHERE id = ?`,
      )
      .run(outputPath, new Date().toISOString(), id);
  }

  markFailed(id: string, errorMessage: string): void {
    this.#db
      .prepare(`UPDATE download_jobs SET status = 'failed', errorMessage = ?, updatedAt = ? WHERE id = ?`)
      .run(errorMessage, new Date().toISOString(), id);
  }

  list(): DownloadJobRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM download_jobs ORDER BY createdAt DESC, rowid DESC`)
      .all() as unknown as Row[];
    return rows.map(rowToRecord);
  }

  /** Number of jobs currently holding an execution slot (ADR-0009) — "queued" jobs don't count, they're waiting for one. */
  countActive(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS count FROM download_jobs WHERE status IN ('pending', 'downloading')`)
      .get() as { count: number };
    return row.count;
  }

  /** The longest-waiting "queued" job, if any, to promote once a slot frees up (ADR-0009). */
  nextQueued(): DownloadJobRecord | undefined {
    const row = this.#db
      .prepare(`SELECT * FROM download_jobs WHERE status = 'queued' ORDER BY createdAt ASC, rowid ASC LIMIT 1`)
      .get() as Row | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** All jobs currently sitting in the Queue, oldest first (ADR-0009). */
  listQueued(): DownloadJobRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM download_jobs WHERE status = 'queued' ORDER BY createdAt ASC, rowid ASC`)
      .all() as unknown as Row[];
    return rows.map(rowToRecord);
  }

  /**
   * Called on server startup: recovers from jobs left mid-flight by a crash/restart (no resume — ADR/Q21).
   * "queued" jobs are deliberately excluded — they haven't started any work yet, so they simply
   * stay queued and re-acquire a slot once the server is back up (ADR-0009).
   */
  failAllInProgress(errorMessage: string): void {
    this.#db
      .prepare(
        `UPDATE download_jobs SET status = 'failed', errorMessage = ?, updatedAt = ? WHERE status IN ('pending', 'downloading', 'moving')`,
      )
      .run(errorMessage, new Date().toISOString());
  }
}
