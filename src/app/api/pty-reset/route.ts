// POST /api/pty-reset
//
// Kills the hub-owned claude child for the given session and flags pty-server
// to respawn it fresh (no --resume). The new child gets a brand-new claude
// sessionId; we pre-register an alias so JSONL events from that new id flow
// into the existing tile rather than spawning a new one.
//
// Body: { sessionId: string }
// Returns: { ok: true, primer: string } — the client stuffs `primer` into
// the tile's input box so the user can review/edit the carry-over context
// before sending it to the freshly-restarted claude. Returns { ok: false,
// error } on 4xx/5xx.

import { resetSession } from "@/lib/pty-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { sessionId?: string };
  try {
    body = (await req.json()) as { sessionId?: string };
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const { sessionId } = body;
  if (!sessionId) {
    return Response.json(
      { ok: false, error: "missing sessionId" },
      { status: 400 },
    );
  }
  const result = resetSession(sessionId);
  if (!result.ok) {
    return Response.json(result, { status: 404 });
  }
  return Response.json(result);
}
