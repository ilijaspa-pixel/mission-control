// Detects which Claude Code sessions are currently "live".
//
// Claude Code writes a small JSON state file per running process at:
//   ~/.claude/sessions/<pid>.json          (primary install)
//   ~/.claude-alt/sessions/<pid>.json      (alt install)
//
// Each file has the shape:
//   { pid, sessionId, cwd, startedAt, kind, entrypoint }
//
// To find live sessions, we read these files and keep the ones whose pid is
// still alive (process.kill(pid, 0) doesn't throw). This gives us a perfect
// PID → sessionId mapping with zero guesswork — no lsof, no ps parsing, no
// "top-N recent files in this cwd" heuristic.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIRS = [
  path.join(os.homedir(), ".claude", "sessions"),
  path.join(os.homedir(), ".claude-alt", "sessions"),
];

type LiveSnapshot = {
  ids: Set<string>;
  byPid: Map<number, { sessionId: string; cwd: string; startedAt: number }>;
  generatedAt: number;
  emptyStreak: number;
  /** Per-session miss streak: how many consecutive refreshes each session
   *  has been absent from the raw scan. Prevents individual sessions from
   *  flapping when Claude rewrites a PID file atomically. */
  missStreak: Map<string, number>;
  /** Maps on-disk sessionIds back to the canonical (first-seen) sessionId
   *  for their PID. Claude Code's /clear rewrites the pidfile with a fresh
   *  sessionId, which would otherwise spawn a new tile; by keeping the
   *  original id as canonical and aliasing the new one, the Mission Control
   *  tile stays in place and the JSONL events stream into the same
   *  snapshot. byPid.sessionId always holds the canonical id. */
  aliasOf: Map<string, string>;
};

const CACHE_KEY = Symbol.for("claude-session-browser.live-cache");
type GlobalWithCache = typeof globalThis & {
  [CACHE_KEY]?: { snap: LiveSnapshot; inFlight: Promise<LiveSnapshot> | null };
};
const g = globalThis as GlobalWithCache;
if (!g[CACHE_KEY]) {
  g[CACHE_KEY] = {
    snap: {
      ids: new Set(),
      byPid: new Map(),
      generatedAt: 0,
      emptyStreak: 0,
      missStreak: new Map(),
      aliasOf: new Map(),
    },
    inFlight: null,
  };
}
// Defensive: previous versions of this module stored a snapshot without
// aliasOf. Patch in place so dev hot-reload doesn't crash.
if (!g[CACHE_KEY]!.snap.aliasOf) {
  g[CACHE_KEY]!.snap.aliasOf = new Map();
}

const REFRESH_MS = 2_500;

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 = no signal, just checks if we can signal the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSessionFile(
  file: string,
): { pid: number; sessionId: string; cwd: string; startedAt: number } | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw) as {
      pid?: number;
      sessionId?: string;
      cwd?: string;
      startedAt?: number;
    };
    if (!obj.pid || !obj.sessionId) return null;
    return {
      pid: obj.pid,
      sessionId: obj.sessionId,
      cwd: obj.cwd ?? "",
      startedAt: obj.startedAt ?? 0,
    };
  } catch {
    return null;
  }
}

function refreshSync(): LiveSnapshot {
  const prev = g[CACHE_KEY]!.snap;
  const ids = new Set<string>();
  const byPid = new Map<
    number,
    { sessionId: string; cwd: string; startedAt: number }
  >();
  // Carry forward every alias we've ever learned. /clear events are sticky:
  // once a PID has been seen with sessionId X and later with Y, the mapping
  // Y → X must persist for the rest of the process lifetime so late-arriving
  // JSONL events still route to the original tile.
  const aliasOf = new Map(prev.aliasOf);

  for (const dir of SESSION_DIRS) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const parsed = readSessionFile(path.join(dir, name));
      if (!parsed) continue;
      if (!isPidAlive(parsed.pid)) continue;
      const currentId = parsed.sessionId;
      const prevForPid = prev.byPid.get(parsed.pid);
      // byPid.sessionId always stores the canonical id, so the previous
      // entry (if any) already tells us the original id for this PID.
      // When the pidfile's id has changed, claude-code hit /clear — record
      // an alias so the new id resolves back to the canonical one.
      let canonical: string;
      if (prevForPid && prevForPid.sessionId !== currentId) {
        canonical = prevForPid.sessionId;
        aliasOf.set(currentId, canonical);
      } else if (prevForPid) {
        canonical = prevForPid.sessionId;
      } else {
        // First time we've seen this PID. If we already have an alias for
        // currentId (carried over from a prior process), honor it; otherwise
        // currentId becomes the canonical for this PID.
        canonical = aliasOf.get(currentId) ?? currentId;
      }
      ids.add(canonical);
      byPid.set(parsed.pid, {
        sessionId: canonical,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
      });
    }
  }

  // ── Per-session anti-flap ─────────────────────────────────────────
  // Claude Code rewrites PID files atomically; a race can make a single
  // session briefly invisible. The old global anti-flap only caught the
  // "all sessions → 0" case. This per-session version keeps each session
  // alive for up to 3 consecutive misses (~7.5s at 2.5s refresh) before
  // actually dropping it, preventing individual tiles from flickering.
  const MAX_MISS = 3;
  const missStreak = new Map<string, number>();

  // Carry forward sessions that were in the previous snapshot but missing
  // from the current raw scan — unless they've exceeded their miss budget.
  for (const [prevId, prevEntry] of prev.byPid) {
    const sessionId = prevEntry.sessionId;
    if (ids.has(sessionId)) continue; // still alive, no miss
    const prevMiss = prev.missStreak.get(sessionId) ?? 0;
    const newMiss = prevMiss + 1;
    if (newMiss < MAX_MISS) {
      // Keep it alive for one more cycle.
      ids.add(sessionId);
      byPid.set(prevId, prevEntry);
      missStreak.set(sessionId, newMiss);
    }
    // else: exceeded budget, let it drop
  }

  // Record miss=0 for sessions that ARE present (reset their streak).
  // No need to store 0 explicitly — absence from missStreak means 0.

  // Legacy global anti-flap: still useful as a last resort when every
  // single session file vanishes simultaneously (filesystem hiccup).
  let finalIds = ids;
  let finalByPid = byPid;
  let emptyStreak = 0;
  if (ids.size === 0 && prev.ids.size > 0) {
    emptyStreak = prev.emptyStreak + 1;
    if (emptyStreak < 3) {
      finalIds = prev.ids;
      finalByPid = prev.byPid;
    }
  }

  const snap: LiveSnapshot = {
    ids: finalIds,
    byPid: finalByPid,
    generatedAt: Date.now(),
    emptyStreak,
    missStreak,
    aliasOf,
  };
  if (process.env.CSB_DEBUG_LIVE === "1") {
    console.log(
      `[live-detect] raw=${ids.size} kept=${finalIds.size} streak=${emptyStreak}`,
      Array.from(finalIds).slice(0, 10),
    );
  }
  g[CACHE_KEY]!.snap = snap;
  return snap;
}

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  const state = g[CACHE_KEY]!;
  const now = Date.now();
  if (now - state.snap.generatedAt < REFRESH_MS) return state.snap;
  // Reading small JSON files + checking PIDs is cheap; run synchronously.
  return refreshSync();
}

export function getLiveSnapshotSync(): LiveSnapshot {
  return g[CACHE_KEY]!.snap;
}

export async function getOpenSessionIds(): Promise<Set<string>> {
  return (await getLiveSnapshot()).ids;
}

export function getOpenSessionIdsSync(): Set<string> {
  return g[CACHE_KEY]!.snap.ids;
}

/** Pre-register an alias from a raw (on-disk) sessionId to the canonical
 *  tile id. Used by the mission-control reset flow: after we kill claude
 *  and respawn it fresh, the new child will write a brand-new sessionId
 *  to its pidfile and its own JSONL. We want chokidar's ingest of that
 *  JSONL to land on the existing tile instead of creating a new one, so
 *  we seed the alias before the watcher sees the file. */
export function registerAlias(rawId: string, canonicalId: string): void {
  const snap = g[CACHE_KEY]!.snap;
  if (!snap.aliasOf) snap.aliasOf = new Map();
  snap.aliasOf.set(rawId, canonicalId);
}

/** Resolves a sessionId to its canonical form. When Claude Code's /clear
 *  rewrites ~/.claude/sessions/<pid>.json with a new sessionId, we alias
 *  the new id back to the original so Mission Control treats the cleared
 *  conversation as a continuation of the same tile. If the cached snapshot
 *  doesn't know this id, we refresh once — a new JSONL file often arrives
 *  before the next scheduled scan. */
export function canonicalSessionId(id: string): string {
  // Guard against pre-alias snapshots lingering in globalThis across dev
  // hot-reloads.
  const snap = g[CACHE_KEY]!.snap;
  if (!snap.aliasOf) snap.aliasOf = new Map();
  const cached = snap.aliasOf.get(id);
  if (cached) return cached;
  const fresh = refreshSync();
  return fresh.aliasOf.get(id) ?? id;
}

/** Returns the earliest known startedAt for a given sessionId, or null.
 *  Each pid file carries a startedAt; we take the min so cost scoping covers
 *  the earliest Warp attached to this session id in the current snapshot. */
export function startedAtFor(sessionId: string): number | null {
  const snap = g[CACHE_KEY]!.snap;
  let best: number | null = null;
  for (const v of snap.byPid.values()) {
    if (v.sessionId === sessionId && v.startedAt > 0) {
      if (best == null || v.startedAt < best) best = v.startedAt;
    }
  }
  return best;
}
