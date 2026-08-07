import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

export interface SseEvent {
  type: string;
  data: unknown;
}

function writeEvent(res: ServerResponse, event: SseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * A Server-Sent-Events channel: publishers push typed events, subscribers (HTTP responses)
 * replay history-so-far then receive live events until close().
 */
export class SseChannel<TEvent extends SseEvent> {
  #emitter = new EventEmitter();
  #history: TEvent[] = [];
  #closed = false;

  publish(event: TEvent): void {
    if (this.#closed) return;
    this.#history.push(event);
    this.#emitter.emit("event", event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emitter.emit("close");
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const event of this.#history) {
      writeEvent(res, event);
    }
    if (this.#closed) {
      res.end();
      return;
    }

    const onEvent = (event: TEvent) => writeEvent(res, event);
    const onClose = () => res.end();
    this.#emitter.on("event", onEvent);
    this.#emitter.on("close", onClose);
    res.on("close", () => {
      this.#emitter.off("event", onEvent);
      this.#emitter.off("close", onClose);
    });
  }
}
