// POST /api/warp-input — DISABLED.
//
// Previously used AppleScript to paste into a frontmost Warp window for
// non-hub-owned tiles. That pulled Warp to the foreground, tripped the
// macOS "Warp would like to access data from other apps" prompt, and
// sometimes spawned ghost tiles. The hub now only renders hub-owned
// tiles, so this path is dead. Kept as a no-op to guarantee no
// AppleScript ever fires from a stale caller.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json({ ok: true, disabled: true });
}
