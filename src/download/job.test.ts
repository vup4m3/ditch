import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { downloadToFile } from "./job.ts";
import type { ManifestSegment } from "./manifest/types.ts";

interface RouteRequest {
  headers: IncomingMessage["headers"];
}

function startServer(routes: Record<string, (req: RouteRequest) => { status?: number; body: Buffer }>): Promise<{
  baseUrl: string;
  server: Server;
  requests: Record<string, RouteRequest[]>;
}> {
  const requests: Record<string, RouteRequest[]> = {};
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    (requests[path] ??= []).push({ headers: req.headers });
    const route = routes[path];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    const { status = 200, body } = route(req);
    res.writeHead(status);
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server, requests });
    });
  });
}

/** fetch() keeps HTTP connections alive by default, which would otherwise keep the test process open. */
function stopServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ditch-job-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("downloads and concatenates unencrypted segments in order", async () => {
  const seg0 = Buffer.from("hello-");
  const seg1 = Buffer.from("world");
  const { baseUrl, server } = await startServer({
    "/seg0.ts": () => ({ body: seg0 }),
    "/seg1.ts": () => ({ body: seg1 }),
  });

  await withTempDir(async (dir) => {
    const segments: ManifestSegment[] = [
      { url: `${baseUrl}/seg0.ts`, durationSeconds: 1, encryption: { method: "NONE" } },
      { url: `${baseUrl}/seg1.ts`, durationSeconds: 1, encryption: { method: "NONE" } },
    ];
    const outputPath = join(dir, "out.ts");

    await downloadToFile(segments, outputPath, {});

    const content = await readFile(outputPath);
    assert.deepEqual(content, Buffer.concat([seg0, seg1]));
  });

  stopServer(server);
});

test("prepends the fMP4 init segment exactly once, even when every segment references it", async () => {
  const init = Buffer.from("INIT");
  const seg0 = Buffer.from("seg0-payload");
  const seg1 = Buffer.from("seg1-payload");
  const { baseUrl, server, requests } = await startServer({
    "/init.mp4": () => ({ body: init }),
    "/seg0.m4s": () => ({ body: seg0 }),
    "/seg1.m4s": () => ({ body: seg1 }),
  });

  await withTempDir(async (dir) => {
    const segments: ManifestSegment[] = [
      { url: `${baseUrl}/seg0.m4s`, durationSeconds: 1, initSegmentUrl: `${baseUrl}/init.mp4`, encryption: { method: "NONE" } },
      { url: `${baseUrl}/seg1.m4s`, durationSeconds: 1, initSegmentUrl: `${baseUrl}/init.mp4`, encryption: { method: "NONE" } },
    ];
    const outputPath = join(dir, "out.mp4");

    await downloadToFile(segments, outputPath, {});

    const content = await readFile(outputPath);
    assert.deepEqual(content, Buffer.concat([init, seg0, seg1]));
    assert.equal(requests["/init.mp4"]?.length, 1);
  });

  stopServer(server);
});

test("decrypts AES-128 segments, fetching the key only once even when shared across segments", async () => {
  const key = randomBytes(16);
  const iv0 = randomBytes(16);
  const iv1 = randomBytes(16);
  const plaintext0 = Buffer.from("segment-zero-plaintext-payload!!");
  const plaintext1 = Buffer.from("segment-one-plaintext-payload!!!");

  function encrypt(plaintext: Buffer, iv: Buffer): Buffer {
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  }

  const { baseUrl, server, requests } = await startServer({
    "/key.bin": () => ({ body: key }),
    "/seg0.ts": () => ({ body: encrypt(plaintext0, iv0) }),
    "/seg1.ts": () => ({ body: encrypt(plaintext1, iv1) }),
  });

  await withTempDir(async (dir) => {
    const segments: ManifestSegment[] = [
      {
        url: `${baseUrl}/seg0.ts`,
        durationSeconds: 1,
        encryption: { method: "AES-128", keyUri: `${baseUrl}/key.bin`, iv: iv0 },
      },
      {
        url: `${baseUrl}/seg1.ts`,
        durationSeconds: 1,
        encryption: { method: "AES-128", keyUri: `${baseUrl}/key.bin`, iv: iv1 },
      },
    ];
    const outputPath = join(dir, "out.ts");

    await downloadToFile(segments, outputPath, {});

    const content = await readFile(outputPath);
    assert.deepEqual(content, Buffer.concat([plaintext0, plaintext1]));
    assert.equal(requests["/key.bin"]?.length, 1);
  });

  stopServer(server);
});

test("sends the given Referer/Cookie/User-Agent headers on every segment request", async () => {
  const seg0 = Buffer.from("payload");
  const { baseUrl, server, requests } = await startServer({
    "/seg0.ts": () => ({ body: seg0 }),
  });

  await withTempDir(async (dir) => {
    const segments: ManifestSegment[] = [
      { url: `${baseUrl}/seg0.ts`, durationSeconds: 1, encryption: { method: "NONE" } },
    ];

    await downloadToFile(segments, join(dir, "out.ts"), {
      referer: "https://example.com/page",
      cookie: "session=abc123",
      userAgent: "ditch-test-agent/1.0",
    });

    const seen = requests["/seg0.ts"]?.[0]?.headers;
    assert.equal(seen?.["referer"], "https://example.com/page");
    assert.equal(seen?.["cookie"], "session=abc123");
    assert.equal(seen?.["user-agent"], "ditch-test-agent/1.0");
  });

  stopServer(server);
});

test("fails the whole job when a segment fetch returns a non-2xx status", async () => {
  const { baseUrl, server } = await startServer({
    "/seg0.ts": () => ({ body: Buffer.from("ok") }),
    "/seg1.ts": () => ({ status: 500, body: Buffer.from("boom") }),
  });

  await withTempDir(async (dir) => {
    const segments: ManifestSegment[] = [
      { url: `${baseUrl}/seg0.ts`, durationSeconds: 1, encryption: { method: "NONE" } },
      { url: `${baseUrl}/seg1.ts`, durationSeconds: 1, encryption: { method: "NONE" } },
    ];

    await assert.rejects(() => downloadToFile(segments, join(dir, "out.ts"), {}));
  });

  stopServer(server);
});
