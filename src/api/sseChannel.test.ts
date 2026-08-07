import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SseChannel } from "./sseChannel.ts";

interface TestEvent {
  type: string;
  data: unknown;
}

function startServer(channel: SseChannel<TestEvent>): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    channel.subscribe(res);
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

async function readEvents(baseUrl: string, count: number): Promise<TestEvent[]> {
  const res = await fetch(baseUrl);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: TestEvent[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const typeLine = chunk.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (typeLine && dataLine) {
        events.push({ type: typeLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) });
      }
    }
  }
  await reader.cancel();
  return events;
}

test("late subscribers replay already-published events before live ones", async () => {
  const channel = new SseChannel<TestEvent>();
  channel.publish({ type: "greeting", data: { message: "first" } });

  const { baseUrl, server } = await startServer(channel);
  try {
    const eventsPromise = readEvents(baseUrl, 2);
    // give the subscription a tick to attach before publishing the live event
    await new Promise((r) => setTimeout(r, 50));
    channel.publish({ type: "greeting", data: { message: "second" } });

    const events = await eventsPromise;
    assert.deepEqual(events, [
      { type: "greeting", data: { message: "first" } },
      { type: "greeting", data: { message: "second" } },
    ]);
  } finally {
    stopServer(server);
  }
});

test("close() ends the stream for connected subscribers", async () => {
  const channel = new SseChannel<TestEvent>();
  const { baseUrl, server } = await startServer(channel);
  try {
    // Don't await yet: with no history to write, headers won't flush until close()
    // triggers res.end() — awaiting fetch() first would deadlock against the next line.
    const resPromise = fetch(baseUrl);
    await new Promise((r) => setTimeout(r, 50));
    channel.close();

    const text = await (await resPromise).text();
    assert.equal(text, "");
  } finally {
    stopServer(server);
  }
});

test("subscribing after close() immediately ends the response", async () => {
  const channel = new SseChannel<TestEvent>();
  channel.publish({ type: "greeting", data: { message: "only" } });
  channel.close();

  const { baseUrl, server } = await startServer(channel);
  try {
    const events = await readEvents(baseUrl, 1);
    assert.deepEqual(events, [{ type: "greeting", data: { message: "only" } }]);
  } finally {
    stopServer(server);
  }
});
