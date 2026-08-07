import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runDetectionSession } from "./session.ts";

function startFixtureServer(routes: Record<string, { contentType: string; body: string }>): Promise<{
  baseUrl: string;
  server: Server;
}> {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? "/"];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": route.contentType });
    res.end(route.body);
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

const MASTER_M3U8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080
hi/index.m3u8
`;

test("detects an HLS manifest fetched by page JS and reports the page URL as referer", async () => {
  const { baseUrl, server } = await startFixtureServer({
    "/page": {
      contentType: "text/html",
      body: `<!doctype html><html><body><script>fetch("/master.m3u8");</script></body></html>`,
    },
    "/master.m3u8": { contentType: "application/vnd.apple.mpegurl", body: MASTER_M3U8 },
  });

  try {
    const result = await runDetectionSession(`${baseUrl}/page`, { timeoutMs: 1500 });

    assert.equal(result.referer, `${baseUrl}/page`);
    assert.ok(result.userAgent.length > 0);
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.some((c) => c.url === `${baseUrl}/low/index.m3u8` && c.label === "480p"));
    assert.ok(result.candidates.some((c) => c.url === `${baseUrl}/hi/index.m3u8` && c.label === "1080p"));
  } finally {
    stopServer(server);
  }
});

test("detects a client-built manifest handed to a Blob (e.g. in-page MediaSource assembly)", async () => {
  const mediaPlaylist = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
  const { baseUrl, server } = await startFixtureServer({
    "/page": {
      contentType: "text/html",
      body: `<!doctype html><html><body><script>
        new Blob([${JSON.stringify(mediaPlaylist)}], { type: "application/vnd.apple.mpegurl" });
      </script></body></html>`,
    },
  });

  try {
    const result = await runDetectionSession(`${baseUrl}/page`, { timeoutMs: 1500 });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.type, "hls");
  } finally {
    stopServer(server);
  }
});

test("invokes onCandidate as each candidate is found, matching the final result", async () => {
  const { baseUrl, server } = await startFixtureServer({
    "/page": {
      contentType: "text/html",
      body: `<!doctype html><html><body><script>fetch("/master.m3u8");</script></body></html>`,
    },
    "/master.m3u8": { contentType: "application/vnd.apple.mpegurl", body: MASTER_M3U8 },
  });

  try {
    const seen: string[] = [];
    const result = await runDetectionSession(`${baseUrl}/page`, {
      timeoutMs: 1500,
      onCandidate: (candidate) => seen.push(candidate.url),
    });

    assert.deepEqual(
      seen.sort(),
      result.candidates.map((c) => c.url).sort(),
    );
    assert.equal(seen.length, 2);
  } finally {
    stopServer(server);
  }
});

test("calls play() on <video> elements found on the page", async () => {
  let playCalled = false;
  const server = createServer((req, res) => {
    if (req.url === "/play-called") {
      playCalled = true;
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body>
        <video></video>
        <script>
          HTMLMediaElement.prototype.play = function() { fetch("/play-called"); return Promise.resolve(); };
        </script>
      </body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl: string = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  try {
    await runDetectionSession(`${baseUrl}/page`, { timeoutMs: 500 });
    assert.equal(playCalled, true);
  } finally {
    stopServer(server);
  }
});
