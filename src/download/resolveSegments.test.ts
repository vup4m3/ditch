import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resolveSegments } from "./resolveSegments.ts";
import type { Candidate } from "../detection/types.ts";

function startServer(routes: Record<string, string>): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    const body = routes[req.url ?? "/"];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

function stopServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

test("a direct candidate resolves to a single unencrypted whole-file segment", async () => {
  const candidate: Candidate = {
    id: "1",
    url: "https://example.com/clip.mp4",
    type: "direct",
    drmProtected: false,
  };

  const segments = await resolveSegments(candidate, {});

  assert.deepEqual(segments, [
    { url: "https://example.com/clip.mp4", durationSeconds: 0, encryption: { method: "NONE" } },
  ]);
});

test("a DASH candidate returns its already-known segments without any network call", async () => {
  const candidate: Candidate = {
    id: "1",
    url: "https://example.com/v0",
    type: "dash",
    drmProtected: false,
    segments: [
      { url: "https://example.com/v0-1.m4s", durationSeconds: 2, encryption: { method: "NONE" } },
      { url: "https://example.com/v0-2.m4s", durationSeconds: 2, encryption: { method: "NONE" } },
    ],
  };

  const segments = await resolveSegments(candidate, {});

  assert.deepEqual(segments, candidate.segments);
});

test("an HLS candidate fetches its media playlist URL and parses the segments", async () => {
  const mediaPlaylist = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
  const { baseUrl, server } = await startServer({ "/hi/index.m3u8": mediaPlaylist });

  try {
    const candidate: Candidate = {
      id: "1",
      url: `${baseUrl}/hi/index.m3u8`,
      type: "hls",
      drmProtected: false,
    };

    const segments = await resolveSegments(candidate, {});

    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.url, `${baseUrl}/hi/seg0.ts`);
  } finally {
    stopServer(server);
  }
});

test("throws if an HLS candidate's URL unexpectedly turns out to be a master playlist", async () => {
  const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n`;
  const { baseUrl, server } = await startServer({ "/master.m3u8": master });

  try {
    const candidate: Candidate = {
      id: "1",
      url: `${baseUrl}/master.m3u8`,
      type: "hls",
      drmProtected: false,
    };

    await assert.rejects(() => resolveSegments(candidate, {}));
  } finally {
    stopServer(server);
  }
});
