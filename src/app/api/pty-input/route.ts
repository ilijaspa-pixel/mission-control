// POST /api/pty-input
//
// Sends raw bytes to a hub-owned PTY's stdin. The Mission Control tiles
// use this so the user can type a message into the inline input bar and
// have it land in claude without needing to open the full /live/<id>
// terminal view.
//
// Body: { sessionId: string, data: string }
//   sessionId — claude session UUID, must be currently hub-owned
//   data      — bytes to write (typically text + "\r" for Enter)

import os from "node:os";
import path from "node:path";
import { getScreenText, writeToSession } from "@/lib/pty-server";
import { getLiveSnapshotSync } from "@/lib/live-detect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Claude Code's TUI uses bracketed paste mode. If we send text + trailing
// carriage return as one chunk, the whole thing looks like a paste event —
// the text lands in the input box but the TUI never treats the CR as
// "submit". Workaround: split the text from its trailing \r (or \n) and
// write the CR separately after a short delay.
// A long paste takes Claude Code longer to take in: an Enter that arrives mid-paste is swallowed
// and the text silently stays in the input box (2026-11-02: a ~2,500-char message "disappeared" and
// only went out glued to the next one). So the pause grows with the size of the message.
const SUBMIT_DELAY_MS = 80;
const submitDelay = (len: number) => Math.min(2000, SUBMIT_DELAY_MS + Math.ceil(len / 4));

// Claude Code appends every submitted prompt to ~/.claude/history.jsonl the moment Enter lands,
// so a new line for this session there is our delivery receipt. Without it a message whose Enter
// got swallowed by something on screen just vanished: "sent" in the UI, never seen by Claude.
// Signs on screen that Claude Code is mid-turn, so a submitted prompt goes to its queue and the
// history line is written later: the working spinner's "(16s · ↓ 379 tokens …)" counter, the
// interrupt hint, and the queued-messages footer.
const BUSY = /esc to interrupt|Press up to edit queued|\(\d+s\s*·/i;

const HISTORY = path.join(os.homedir(), ".claude", "history.jsonl");
// The receipt must be THIS message (one sent a second earlier used to count), and it may be filed
// under a newer id: after /clear Claude Code logs with the new id, which Mission Control maps back
// to the original, so every later send looked lost and got retyped (review 2026-11-03).
const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
function idsFor(sessionId: string): Set<string> {
  const ids = new Set([sessionId]);
  try {
    for (const [raw, canon] of getLiveSnapshotSync().aliasOf) if (canon === sessionId) ids.add(raw);
  } catch {}
  return ids;
}
type HistoryLine = { sessionId?: string; timestamp?: number; display?: string; pastedContents?: Record<string, { content?: string }> };
function isThisMessage(o: HistoryLine, text: string) {
  const want = norm(text).slice(0, 40);
  if (!want) return true;
  if (norm(o.display ?? "").includes(want)) return true;
  const pasted = Object.values(o.pastedContents ?? {}).map((v) => v?.content ?? "").join(" ");
  if (pasted && norm(pasted).includes(want)) return true;
  // A long message goes in as one paste; when its body isn't kept inline, the placeholder is the receipt.
  return (text.length > 400 || text.includes("\n")) && /\[Pasted text/.test(o.display ?? "");
}
async function landed(fs: typeof import("node:fs"), sessionId: string, since: number, waitMs: number, text = "") {
  const ids = idsFor(sessionId);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const st = fs.statSync(HISTORY);
      const start = Math.max(0, st.size - 64_000);
      const fd = fs.openSync(HISTORY, "r");
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      for (const line of buf.toString("utf8").split("\n").reverse()) {
        if (![...ids].some((id) => line.includes(id))) continue;
        try {
          const o = JSON.parse(line) as HistoryLine;
          if (o.sessionId && ids.has(o.sessionId) && (o.timestamp ?? 0) >= since && isThisMessage(o, text)) return true;
        } catch {}
      }
    } catch {}
    if (Date.now() > until) return false;
    await sleep(250);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  let body: { sessionId?: string; data?: string; confirm?: boolean };
  try {
    body = (await req.json()) as { sessionId?: string; data?: string; confirm?: boolean };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const { sessionId, data } = body;
  if (!sessionId || typeof data !== "string") {
    return Response.json(
      { error: "missing sessionId or data" },
      { status: 400 },
    );
  }
  const fs = await import("node:fs");

  // Split trailing CR/LF off the payload so the TUI sees them as a
  // separate "Enter" keystroke rather than part of the paste.
  const match = data.match(/^(.*?)([\r\n]+)$/s);
  const textPart = match ? match[1] : data;
  const submitPart = match ? match[2] : "";

  const sentAt = Date.now() - 1000;
  let ok = true;
  let delivered: boolean | null = null;
  // The PTY hands long input to Claude Code in 1,024-byte chunks, and Claude Code takes each
  // chunk as separate typing: on 2026-11-03 a 2,086-byte message arrived as its last 42 bytes
  // and a 1,090-byte one as its last 68. Wrapping it in bracketed-paste markers makes the whole
  // message one paste however it is chunked (it shows as "[Pasted text #N]" and is expanded on
  // submit). Only for long or multi-line text, so menu answers and short messages type as before.
  const asPaste = (t: string) => (t.length > 400 || t.includes("\n") ? `\x1b[200~${t}\x1b[201~` : t);
  if (textPart) {
    ok = writeToSession(sessionId, asPaste(textPart)) && ok;
  }
  if (ok && submitPart) {
    await sleep(submitDelay(textPart.length));
    ok = writeToSession(sessionId, submitPart) && ok;
    // Only chat messages opt in to the receipt check. Menu answers ("1" + Enter) and raw keys
    // never get the retry Enter, which could otherwise confirm the next prompt by accident.
    if (ok && body.confirm && textPart.trim()) {
      delivered = await landed(fs, sessionId, sentAt, 2500, textPart);
      // Not submitted: look at the screen. If our text is sitting in the input box, its Enter
      // was eaten, so press Enter again; if the text is gone too, type the whole message again.
      for (let attempt = 1; !delivered && attempt <= 3; attempt++) {
        const screen = (await getScreenText(sessionId)) ?? "";
        fs.appendFileSync(
          "/tmp/pty-lost-screens.log",
          `\n===== ${new Date().toISOString()} session=${sessionId} attempt=${attempt} msg=${JSON.stringify(textPart.slice(0, 80))}\n${screen}\n`,
        );
        // Compare without whitespace: long messages wrap across lines inside the input box.
        const flat = (s: string) => s.replace(/[\s│╭╮╰╯─>]+/g, "");
        const probe = flat(textPart).slice(-20);
        // Sessions started before Mission Control kept a screen copy have none: then try a bare
        // Enter first (submits text stuck in the box) and only retype once that didn't work.
        const blind = !screen || screen.startsWith("[blank");
        // A pasted message sits in the box as "[Pasted text #N ...]", not as its own words.
        const inBox = (probe && flat(screen).includes(probe)) || (asPaste(textPart) !== textPart && screen.includes("[Pasted text"));

        // Claude Code writes history.jsonl when it TAKES a prompt, not when Enter lands. Mid-turn
        // it parks the prompt in its queue instead, so the receipt is late by however long the
        // current turn runs: 2026-11-03, one message was called lost at 11.5s and written at ~19s,
        // and a second was still pending behind a 59s turn. So whenever the screen says Claude is
        // working, give the receipt a long window instead of a 3s one, and never retype — retyping
        // into the queue delivers the same message twice.
        const busy = BUSY.test(screen);
        if (!blind && !inBox && busy) {
          delivered = await landed(fs, sessionId, sentAt, 120_000, textPart);
          break;
        }

        if (blind ? attempt === 1 : inBox) {
          writeToSession(sessionId, "\r");
        } else if (busy) {
          // Text unaccounted for while Claude works: a bare Enter is safe, retyping is not.
          writeToSession(sessionId, "\r");
        } else {
          writeToSession(sessionId, asPaste(textPart));
          await sleep(submitDelay(textPart.length) + 150);
          writeToSession(sessionId, "\r");
        }
        delivered = await landed(fs, sessionId, sentAt, busy ? 120_000 : 3000, textPart);
      }
    }
  }

  fs.appendFileSync(
    "/tmp/pty-input-debug.log",
    // Only the start of each message: logging the full text kept everything he typed, bank details included.
    `[${new Date().toISOString()}] session=${sessionId} ok=${ok} delivered=${delivered} len=${data.length} data=${JSON.stringify(data.slice(0, 60))}\n`,
  );
  if (!ok) {
    return Response.json(
      { error: "session not hub-owned" },
      { status: 404 },
    );
  }
  if (delivered === false) {
    return Response.json({ ok: false, delivered: false, error: "not delivered" }, { status: 409 });
  }
  return Response.json({ ok: true });
}

// GET /api/pty-input?screen=<sessionId>: the session's current screen as text (debugging).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("screen");
  if (!id) return Response.json({ error: "missing screen" }, { status: 400 });
  const screen = await getScreenText(id, Number(new URL(req.url).searchParams.get("rows") ?? 40));
  return screen === null ? Response.json({ error: "no screen" }, { status: 404 }) : new Response(screen);
}
