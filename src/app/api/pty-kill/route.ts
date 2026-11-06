// POST /api/pty-kill
//
// Permanently kills a hub-owned claude session. Unlike {type:"kill"} over
// the WS (which races with the stale onPtyExit auto-restart closure), this
// goes through killSession() which neutralizes the closure first.
//
// Body: { sessionId: string }

import { killAllByFlavor, killSession, unlockFlavor } from "@/lib/pty-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const g = globalThis as unknown as {
    [k: symbol]: {
      sessions?: Map<string, { flavor?: string; key: string; pty?: { pid?: number }; _orphanPid?: number }>;
      claude2LockUntil?: number;
    };
  };
  const KEY = Symbol.for("claude-session-browser.pty-server");
  const state = g[KEY];
  if (!state) return Response.json({ ok: false, error: "no state" });
  const sessions: Array<{ key: string; flavor?: string; pid?: number }> = [];
  state.sessions?.forEach((s) => {
    sessions.push({
      key: s.key,
      flavor: s.flavor,
      pid: s.pty?.pid ?? s._orphanPid,
    });
  });
  return Response.json({
    ok: true,
    sessions,
    claude2LockUntil: state.claude2LockUntil ?? null,
    now: Date.now(),
  });
}

export async function POST(req: Request) {
  let body: {
    sessionId?: string;
    flavor?: "claude" | "claude2";
    unlock?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (body.flavor && body.unlock) {
    return Response.json(unlockFlavor(body.flavor));
  }
  if (body.flavor) {
    return Response.json(killAllByFlavor(body.flavor));
  }
  if (!body.sessionId) {
    return Response.json(
      { ok: false, error: "missing sessionId or flavor" },
      { status: 400 },
    );
  }
  const result = killSession(body.sessionId);
  if (!result.ok) {
    return Response.json(result, { status: 404 });
  }
  return Response.json(result);
}
