import express from "express";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApp } from "./api/app.ts";
import { JobStore } from "./db/jobStore.ts";
import { runDetectionSession } from "./detection/session.ts";
import { resolveSegments } from "./download/resolveSegments.ts";
import { downloadToFile } from "./download/job.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? join(process.cwd(), "downloads");
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), "data", "ditch.sqlite");

async function main() {
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  await mkdir(dirname(DB_PATH), { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  const jobStore = new JobStore(db);
  jobStore.failAllInProgress("伺服器重啟，任務中斷");

  const app = createApp({
    jobStore,
    downloadsDir: DOWNLOADS_DIR,
    runDetection: (pageUrl, onCandidate) => runDetectionSession(pageUrl, { onCandidate }),
    resolveSegments,
    downloadToFile,
  });

  app.use(express.static(join(import.meta.dirname, "public")));

  const server = app.listen(PORT, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : PORT;
    console.log(`ditch listening on http://localhost:${actualPort}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
