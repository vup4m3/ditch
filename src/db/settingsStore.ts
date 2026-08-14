import type { DatabaseSync } from "node:sqlite";

const CONCURRENCY_LIMIT_KEY = "concurrencyLimit";
// Used until the user sets one via the Settings UI (ADR-0009).
const DEFAULT_CONCURRENCY_LIMIT = 3;

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
}
