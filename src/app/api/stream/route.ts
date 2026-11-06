// Server-Sent Events endpoint. Clients (the hub page) open an EventSource and
// receive a stream of `delta` events as session JSONL files change on disk.

import { subscribe, listSnapshots, getFullSession, type Delta } from "@/lib/store";
import type { TimelineEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (data: unknown, event?: string) => {
        if (closed) return;
        const prefix = event ? `event: ${event}\n` : "";
        const payload = `${prefix}data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      // Kick connection with a comment so browsers don't buffer forever.
      try {
        controller.enqueue(encoder.encode(": hello\n\n"));
      } catch {
        closed = true;
      }

      // Ship a full snapshot on every connect (including auto-reconnects).
      // EventSource reconnects silently and clients that slept through
      // deltas would otherwise render stale tiles forever. Sending the
      // current state here lets the client replace its in-memory map each
      // time the stream re-opens.
      const sessions = await listSnapshots();
      const recent: Record<string, TimelineEvent[]> = {};
      for (const s of sessions) {
        const full = getFullSession(s.id);
        recent[s.id] = (full?.events ?? full?.recent ?? []).slice(-300);
      }
      send({ ok: true, ts: Date.now(), sessions, recent }, "ready");

      const unsub = subscribe((delta: Delta) => {
        send(delta, "delta");
      });

      // Heartbeat every 20s to keep the connection alive through proxies.
      const hb = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 20_000);

      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Tear down when the client disconnects. Without this, each dropped
      // tab leaked a delta subscription — we hit "MaxListenersExceeded" at
      // 11 accumulated subscriptions.
      if (request.signal.aborted) {
        close();
      } else {
        request.signal.addEventListener("abort", close, { once: true });
      }
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
