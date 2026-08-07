import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createBrowserSession } from "./browserFetch.ts";

function startServer(): Promise<{ baseUrl: string; server: Server }> {
  // Simulates a Cloudflare-style gate: /protected only serves real content to a client
  // that already carries the "cleared" cookie set by visiting /warmup first — a bare,
  // cookie-less request (like Node's fetch) gets 403.
  const server = createServer((req, res) => {
    if (req.url === "/warmup") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "cleared=1" });
      res.end("<html><body>warmed up</body></html>");
      return;
    }
    if (req.url === "/protected") {
      const cookie = req.headers.cookie ?? "";
      if (!cookie.includes("cleared=1")) {
        res.writeHead(403);
        res.end("blocked");
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([1, 2, 3, 255, 254, 0]));
      return;
    }
    res.writeHead(404);
    res.end();
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

test("a bare Node fetch to the protected endpoint is blocked (sanity check for why the fallback exists)", async () => {
  const { baseUrl, server } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/protected`);
    assert.equal(res.status, 403);
  } finally {
    stopServer(server);
  }
});

test("createBrowserSession warms up cookies by visiting the given URL, then fetches the protected resource successfully", async () => {
  const { baseUrl, server } = await startServer();
  const session = await createBrowserSession(`${baseUrl}/warmup`, "test-agent/1.0");
  try {
    const buf = await session.fetchBuffer(`${baseUrl}/protected`);
    assert.deepEqual(buf, Buffer.from([1, 2, 3, 255, 254, 0]));
  } finally {
    await session.close();
    stopServer(server);
  }
});

test("fetchBuffer rejects when the resource is genuinely unreachable, even with a warmed-up session", async () => {
  const { baseUrl, server } = await startServer();
  const session = await createBrowserSession(`${baseUrl}/warmup`, "test-agent/1.0");
  try {
    await assert.rejects(() => session.fetchBuffer(`${baseUrl}/does-not-exist`));
  } finally {
    await session.close();
    stopServer(server);
  }
});
