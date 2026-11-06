// POST /api/attention
//
// Ingress for the Claude Code `Notification` hook (~/.claude/hooks/notify-waiting.sh).
// Claude Code fires that hook whenever a session is blocked on the user — a
// permission prompt, a question, or idle input — and the hook curls this route
// so the matching Mission Control tile can light up.
//
// Why this exists: `waitingForInput` is inferred from the transcript and only
// flips on stop_reason "end_turn". A session parked on an allow/deny dialog
// still reports "tool_use", so it renders as *thinking* — the tile looks busy
// while it is actually stuck waiting. Nothing in the JSONL distinguishes the
// two; only the hook knows.
//
// Body: the raw Claude Code hook payload
//   { session_id?: string, cwd?: string, message?: string, hook_event_name?: string }

import { markAttention } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    session_id?: string;
    cwd?: string;
    message?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const message = (body.message ?? "").trim() || "Waiting for your input";
  const matched = markAttention(
    body.session_id ?? null,
    message,
    body.cwd ?? null,
  );

  // A miss is normal and not an error: the hook fires for every Claude Code
  // session on the machine, including ones this hub does not own.
  return Response.json({ ok: true, matched });
}
