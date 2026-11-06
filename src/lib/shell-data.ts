// Server-side initial payload for ConsoleShell ("/" and "/live/[id]").
// Mirrors what "/" (hub) and "/s/[id]" load, so the shell has every
// console's snapshot plus history on first paint.

import { getFullSession, listSnapshots } from "./store";
import type { SessionSnapshot, TimelineEvent } from "./types";
import { isBlocked } from "./console-meta";

const RECENT_PER_CONSOLE = 300; // same as the hub + SSE ready payload
const SELECTED_HISTORY = 800; // more scrollback for the open console

export async function loadShellData(selectedId: string | null): Promise<{
  sessions: SessionSnapshot[];
  recent: Record<string, TimelineEvent[]>;
  selected: SessionSnapshot | null;
}> {
  const all = await listSnapshots();
  const recent: Record<string, TimelineEvent[]> = {};
  const sessions: SessionSnapshot[] = [];
  let selected: SessionSnapshot | null = null;

  // Default selection on "/": a console that needs you, else most recent.
  let pick = selectedId;
  if (!pick) {
    const owned = all.filter((s) => s.hubOwned);
    const needs = owned.filter((s) => s.isLive && isBlocked(s));
    const pool = needs.length ? needs : owned;
    pool.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
    pick = pool[0]?.id ?? null;
  }

  for (const s of all) {
    const isSel = s.id === pick;
    if (!s.hubOwned && !isSel) continue;
    sessions.push(s);
    const full = getFullSession(s.id);
    recent[s.id] = (full?.events ?? full?.recent ?? []).slice(
      -(isSel ? SELECTED_HISTORY : RECENT_PER_CONSOLE),
    );
    if (isSel) selected = s;
  }

  // /live/<id> for a session not in the listing: look it up directly.
  if (pick && !selected && pick !== "new") {
    const full = getFullSession(pick);
    if (full) {
      const { events, costEvents: _c, ...snap } = full;
      void _c;
      selected = snap;
      sessions.push(snap);
      recent[snap.id] = events.slice(-SELECTED_HISTORY);
    }
  }

  return { sessions, recent, selected };
}
