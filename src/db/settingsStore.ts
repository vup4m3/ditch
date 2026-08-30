import type { DatabaseSync } from "node:sqlite";

const CONCURRENCY_LIMIT_KEY = "concurrencyLimit";
// Used until the user sets one via the Settings UI (ADR-0009).
const DEFAULT_CONCURRENCY_LIMIT = 3;

const TRANSCODE_ENABLED_KEY = "transcodeEnabled";
// Off by default: transcoding requires ffmpeg in the runtime image, and every existing
// deployment predates this feature (ADR-0012) — opt in explicitly via the Settings UI.
const DEFAULT_TRANSCODE_ENABLED = false;

const TRANSCODE_CONCURRENCY_LIMIT_KEY = "transcodeConcurrencyLimit";
// AV1 software encoding is CPU-heavy; default conservatively to one at a time (ADR-0013).
const DEFAULT_TRANSCODE_CONCURRENCY_LIMIT = 1;

const SUGGESTED_FILENAME_MAX_LENGTH_KEY = "suggestedFilenameMaxLength";
// Character cap the frontend applies to the page-title-derived Suggested Filename (ADR-0014).
const DEFAULT_SUGGESTED_FILENAME_MAX_LENGTH = 80;
// Below this the suggestion stops being useful; also the floor accepted from the Settings UI.
const MIN_SUGGESTED_FILENAME_MAX_LENGTH = 10;
// Stored in place of a real length to mean "no cap"; surfaces as null over the API.
const SUGGESTED_FILENAME_MAX_LENGTH_OFF = 0;

interface Row {
  value: string;
}

/** Generic key-value settings, backed by the same SQLite DB as JobStore (ADR-0009). */
export class SettingsStore {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  #get(key: string): string | undefined {
    const row = this.#db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as Row | undefined;
    return row?.value;
  }

  #set(key: string, value: string): void {
    this.#db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  /** Max number of Download Jobs allowed to hold an execution slot (queued/pending/downloading) at once. */
  getConcurrencyLimit(): number {
    const raw = this.#get(CONCURRENCY_LIMIT_KEY);
    return raw !== undefined ? Number(raw) : DEFAULT_CONCURRENCY_LIMIT;
  }

  setConcurrencyLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("concurrency limit must be an integer >= 1");
    }
    this.#set(CONCURRENCY_LIMIT_KEY, String(limit));
  }

  /** Whether newly-created Download Jobs transcode to MKV/AV1 (ADR-0012). Frozen per-job at creation. */
  getTranscodeEnabled(): boolean {
    const raw = this.#get(TRANSCODE_ENABLED_KEY);
    return raw !== undefined ? raw === "true" : DEFAULT_TRANSCODE_ENABLED;
  }

  setTranscodeEnabled(enabled: boolean): void {
    this.#set(TRANSCODE_ENABLED_KEY, enabled ? "true" : "false");
  }

  /** Max number of Download Jobs allowed to hold a transcode slot (transcodeQueued/transcoding) at once (ADR-0013). */
  getTranscodeConcurrencyLimit(): number {
    const raw = this.#get(TRANSCODE_CONCURRENCY_LIMIT_KEY);
    return raw !== undefined ? Number(raw) : DEFAULT_TRANSCODE_CONCURRENCY_LIMIT;
  }

  setTranscodeConcurrencyLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("transcode concurrency limit must be an integer >= 1");
    }
    this.#set(TRANSCODE_CONCURRENCY_LIMIT_KEY, String(limit));
  }

  /**
   * Max characters the frontend keeps of the page-title-derived Suggested Filename (ADR-0014),
   * or null for no cap. Purely cosmetic — the server-side byte cap in app.ts is separate.
   */
  getSuggestedFilenameMaxLength(): number | null {
    const raw = this.#get(SUGGESTED_FILENAME_MAX_LENGTH_KEY);
    const value = raw !== undefined ? Number(raw) : DEFAULT_SUGGESTED_FILENAME_MAX_LENGTH;
    return value === SUGGESTED_FILENAME_MAX_LENGTH_OFF ? null : value;
  }

  setSuggestedFilenameMaxLength(length: number | null): void {
    if (length === null) {
      this.#set(SUGGESTED_FILENAME_MAX_LENGTH_KEY, String(SUGGESTED_FILENAME_MAX_LENGTH_OFF));
      return;
    }
    if (!Number.isInteger(length) || length < MIN_SUGGESTED_FILENAME_MAX_LENGTH) {
      throw new Error(`suggested filename max length must be an integer >= ${MIN_SUGGESTED_FILENAME_MAX_LENGTH} or null`);
    }
    this.#set(SUGGESTED_FILENAME_MAX_LENGTH_KEY, String(length));
  }
}
