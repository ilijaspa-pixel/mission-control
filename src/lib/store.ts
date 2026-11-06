// In-memory session store with a chokidar watcher over ~/.claude/projects/.
// This module is intentionally a Node-only singleton: it holds file handles,
// cursors, and a pub/sub channel. Next.js server components import `getStore`
// and UI route handlers import `subscribe` for the SSE stream.

import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { emptySnapshot, parseLines, projectLabelFor } from "./parser";
import {
  canonicalSessionId,
  getOpenSessionIds,
  getOpenSessionIdsSync,
  startedAtFor,
} from "./live-detect";
import {
  getStatusForSession,
  refreshStatusCache,
} from "./status-cache";
import { getHubOwnedSessionIds, startPtyServer } from "./pty-server";
import type { FullSession, SessionSnapshot, TimelineEvent } from "./types";

const STATUS_CACHE_DIR = path.join(os.homedir(), ".claude", "status-cache");

// Watch both the primary and alt Claude config dirs — users with multiple
// installs (e.g. a stable + beta) have sessions spread across both, and
// leaving out .claude-alt means the hub silently misses those Warps.
const PROJECT_ROOTS = [
  path.join(os.homedir(), ".claude", "projects"),
  path.join(os.homedir(), ".claude-alt", "projects"),
];
// Strict liveness: a session is live ONLY if a running claude process has
// registered itself via ~/.claude/sessions/<pid>.json. The old mtime fallback
// caused ghost "live" sessions for any JSONL touched in the last 10 min —
// wrong, because a recently-written JSONL whose process has exited is NOT
// live. Kept as a tight 30s grace window to bridge atomic write races.
const MTIME_LIVE_WINDOW_MS = 30 * 1000;

type Delta =
  | { kind: "snapshot"; session: SessionSnapshot }
  | { kind: "events"; sessionId: string; events: TimelineEvent[]; snapshot: SessionSnapshot }
  | { kind: "liveness"; sessionId: string; isLive: boolean }
  | { kind: "evict"; sessionId: string };

type StoreShape = {
  sessions: Map<string, FullSession>;
  cursors: Map<string, number>; // session id -> byte offset
  watcher: FSWatcher | null;
  bus: EventEmitter;
  started: boolean;
  livenessTimer: NodeJS.Timeout | null;
};

// Persist across hot reloads in dev.
const globalKey = Symbol.for("claude-session-browser.store");
type GlobalWithStore = typeof globalThis & { [key: symbol]: StoreShape | undefined };
const g = globalThis as GlobalWithStore;

function createStore(): StoreShape {
  return {
    sessions: new Map(),
    cursors: new Map(),
    watcher: null,
    bus: new EventEmitter(),
    started: false,
    livenessTimer: null,
  };
}

function getStoreInternal(): StoreShape {
  if (!g[globalKey]) g[globalKey] = createStore();
  return g[globalKey]!;
}

export function snapshotFor(store: FullSession): SessionSnapshot {
  // Strip full event arrays to keep hub payloads small; tiles only need `recent`.
  const { events: _events, costEvents: _costs, ...snap } = store;
  void _events;
  void _costs;
  return snap;
}

function readLinesFromOffset(
  file: string,
  fromOffset: number,
): { lines: string[]; newOffset: number } {
  const stat = fs.statSync(file);
  if (stat.size <= fromOffset) return { lines: [], newOffset: fromOffset };
  const fd = fs.openSync(file, "r");
  try {
    const len = stat.size - fromOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromOffset);
    const text = buf.toString("utf8");
    // Be conservative: only treat fully-terminated lines as complete.
    const nl = text.lastIndexOf("\n");
    if (nl === -1) return { lines: [], newOffset: fromOffset };
    const complete = text.slice(0, nl);
    const newOffset = fromOffset + Buffer.byteLength(complete, "utf8") + 1;
    const lines = complete.split("\n");
    return { lines, newOffset };
  } finally {
    fs.closeSync(fd);
  }
}

function projectDirForFile(file: string): string {
  // ~/.claude/projects/<encoded>/<session-id>.jsonl
  return path.basename(path.dirname(file));
}

function sessionIdForFile(file: string): string {
  return path.basename(file, ".jsonl");
}

function ingestFile(store: StoreShape, file: string, initial: boolean) {
  if (!file.endsWith(".jsonl")) return;
  // Skip files inside nested subagent / memory dirs
  const segments = file.split(path.sep);
  const projectsIdx = segments.findIndex((s) => s === "projects");
  if (projectsIdx < 0) return;
  // Expect: projects/<encoded>/<id>.jsonl — depth == projectsIdx + 3
  if (segments.length !== projectsIdx + 3) return;

  // Disambiguate same-named encoded project dirs across .claude and
  // .claude-alt by prefixing with the install root's parent dir name.
  const installName = segments[projectsIdx - 1] ?? ".claude"; // ".claude" or ".claude-alt"
  const projectDir =
    installName === ".claude-alt"
      ? `alt::${projectDirForFile(file)}`
      : projectDirForFile(file);
  // fileId is whatever the JSONL is named on disk. After /clear claude-code
  // writes a fresh file with a new sessionId, but we still want to feed its
  // events into the existing tile — canonicalSessionId translates back to
  // the original. Cursor stays keyed by fileId because each JSONL has its
  // own byte offset.
  const fileId = sessionIdForFile(file);
  const sessionId = canonicalSessionId(fileId);

  let snap = store.sessions.get(sessionId);
  if (!snap) {
    snap = emptySnapshot(sessionId, projectDir);
    store.sessions.set(sessionId, snap);
    store.cursors.set(fileId, 0);
  } else if (!snap.projectDir) {
    // Existing snap was synthesized empty by listSnapshots() for a
    // hub-owned session before its JSONL hit disk. Populate projectDir
    // and projectLabel from the file path now that we know them.
    snap.projectDir = projectDir;
    snap.projectLabel = projectLabelFor(projectDir);
  }

  const cursor = store.cursors.get(fileId) ?? 0;
  const { lines, newOffset } = readLinesFromOffset(file, cursor);
  if (lines.length === 0) return;
  const added = parseLines(snap, lines);
  store.cursors.set(fileId, newOffset);

  // Recompute liveness: primary signal is lsof (Claude process holds the file
  // open → a Warp window is attached); secondary is recent mtime. Also
  // honor hub-owned PTYs (the user spawned a session via "+ new session"
  // and pty-server is keeping it alive even after they navigated away).
  const openIds = getOpenSessionIdsSync();
  const hubOwnedIds = getHubOwnedSessionIds();
  const hubOwned = hubOwnedIds.has(sessionId);
  let live = openIds.has(sessionId) || hubOwned;
  if (!live) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      live = Date.now() - mtime < MTIME_LIVE_WINDOW_MS;
    } catch {
      live = false;
    }
  }
  snap.isLive = live;
  snap.hubOwned = hubOwned;

  if (initial) return; // initial backfill is silent; hub reads fresh

  const delta: Delta = {
    kind: "events",
    sessionId,
    events: added,
    snapshot: snapshotFor(snap),
  };
  store.bus.emit("delta", delta);
}

function backfillAll(store: StoreShape) {
  for (const root of PROJECT_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const projectDirs = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        ingestFile(store, path.join(dir, f), true);
      }
    }
  }
}

function startLivenessTicker(store: StoreShape) {
  if (store.livenessTimer) return;
  const tick = async () => {
    // Refresh the lsof view of "open by a running claude process".
    const openIds = await getOpenSessionIds();
    const hubOwnedIds = getHubOwnedSessionIds();
    const now = Date.now();
    const evicted: string[] = [];
    for (const [sid, snap] of store.sessions) {
      // Evict phantom tiles: entries that were synthesized from a past
      // openIds/hubOwnedIds moment (or whose backing JSONL got rotated
      // away) that never acquired any events and aren't currently live.
      // Without this sweep, every transient alias leaves a dead tile
      // stuck in the grid until the process restarts.
      if (
        snap.eventCount === 0 &&
        !hubOwnedIds.has(sid) &&
        !openIds.has(sid)
      ) {
        store.sessions.delete(sid);
        store.cursors.delete(sid);
        evicted.push(sid);
        continue;
      }
      const prev = snap.isLive;
      const prevHubOwned = snap.hubOwned;
      const hubOwned = hubOwnedIds.has(snap.id);
      let live = openIds.has(snap.id) || hubOwned;
      if (!live) {
        const lastTs = snap.lastTs ? new Date(snap.lastTs).getTime() : 0;
        live = lastTs > 0 && now - lastTs < MTIME_LIVE_WINDOW_MS;
      }
      if (prev !== live || prevHubOwned !== hubOwned) {
        snap.isLive = live;
        snap.hubOwned = hubOwned;
        // Push a full snapshot delta so the client picks up the
        // hubOwned change too (the lightweight liveness delta only
        // carries isLive).
        store.bus.emit("delta", {
          kind: "events",
          sessionId: snap.id,
          events: [],
          snapshot: snapshotFor(snap),
        } satisfies Delta);
      }
    }
    for (const sid of evicted) {
      store.bus.emit("delta", {
        kind: "evict",
        sessionId: sid,
      } satisfies Delta);
    }
  };
  // Kick immediately so first render is accurate
  void tick();
  store.livenessTimer = setInterval(() => {
    void tick();
  }, 4_000);
}

function start(): StoreShape {
  const store = getStoreInternal();
  if (store.started) return store;
  store.started = true;

  // Boot the standalone WebSocket PTY bridge on port 4101 so the hub can
  // spawn interactive terminals for hub-owned Claude sessions. Fire-and-forget
  // — failures are logged but don't block the read-only observer functionality.
  void startPtyServer();

  backfillAll(store);

  // Watch the project root directories themselves. chokidar v4 dropped
  // glob support, so the previous `path.join(r, "*", "*.jsonl")` pattern
  // was being treated as a literal path that matched nothing — every
  // new JSONL written after server startup was silently ignored, which
  // is why fresh hub-spawned sessions rendered as empty tiles. We watch
  // the dirs and filter on .jsonl in the handlers instead.
  const watchPaths = PROJECT_ROOTS.filter((r) => fs.existsSync(r));
  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    depth: 2,
  });
  const onJsonl = (f: string) => {
    if (f.endsWith(".jsonl")) ingestFile(store, f, false);
  };
  watcher.on("add", onJsonl);
  watcher.on("change", onJsonl);
  watcher.on("error", (err) => console.error("[watcher]", err));
  store.watcher = watcher;

  // Watch the status-cache directory — each file is rewritten by our patched
  // statusline.cjs on every Claude Code status render. When a file changes,
  // re-parse the whole dir (cheap) and push a delta so tiles update live
  // without waiting for a full page reload.
  try {
    fs.mkdirSync(STATUS_CACHE_DIR, { recursive: true });
  } catch {}
  const scWatcher = chokidar.watch(path.join(STATUS_CACHE_DIR, "*.json"), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 30 },
  });
  const onCacheChange = (file: string) => {
    refreshStatusCache();
    // statusline.cjs writes files named by the current (raw) sessionId;
    // after /clear that's the new id, not the tile's canonical one. Map
    // back so updates land on the existing tile instead of silently
    // missing.
    const rawId = path.basename(file, ".json");
    const sessionId = canonicalSessionId(rawId);
    const snap = store.sessions.get(sessionId);
    if (!snap) return;
    const sc = getStatusForSession(sessionId);
    if (!sc) return;
    if (sc.costUsd != null) {
      snap.costUsd = sc.costUsd;
      snap.costExact = true;
      snap.costKnown = true;
    }
    if (sc.contextUsedTokens != null) snap.contextTokens = sc.contextUsedTokens;
    if (sc.contextUsedPct != null) snap.contextPct = sc.contextUsedPct;
    if (sc.modelDisplay) snap.modelDisplay = sc.modelDisplay;
    if (sc.modelId) snap.model = sc.modelId;
    store.bus.emit("delta", {
      kind: "events",
      sessionId,
      events: [],
      snapshot: snapshotFor(snap),
    } satisfies Delta);
  };
  scWatcher.on("add", onCacheChange);
  scWatcher.on("change", onCacheChange);
  scWatcher.on("error", (err) => console.error("[sc-watcher]", err));

  startLivenessTicker(store);
  return store;
}

export function getStore() {
  return start();
}

export async function listSnapshots(): Promise<SessionSnapshot[]> {
  const store = getStore();
  // Refresh live status from sessions/*.json files on demand so the first
  // render is accurate.
  const openIds = await getOpenSessionIds();
  // Also refresh the status cache written by ~/.claude/statusline.cjs —
  // it's the source of truth for cost/context on live sessions.
  const statusCache = refreshStatusCache();
  const now = Date.now();

  // A live session may not have any parsed events yet (brand-new Warp that
  // just spawned, no messages sent yet, JSONL barely populated). Synthesize
  // empty snapshots for live session ids we haven't backfilled from disk so
  // every running claude shows up on the hub immediately.
  for (const id of openIds) {
    if (!store.sessions.has(id)) {
      store.sessions.set(id, emptySnapshot(id, ""));
      store.cursors.set(id, 0);
    }
  }

  const hubOwnedIds = getHubOwnedSessionIds();
  // Synthesize empty snapshots for hub-owned sessions that haven't yet
  // registered a JSONL on disk (very young brand-new sessions). They
  // need to appear in the hub immediately so the user can see the tile
  // they just spawned.
  for (const id of hubOwnedIds) {
    if (!store.sessions.has(id)) {
      store.sessions.set(id, emptySnapshot(id, ""));
      store.cursors.set(id, 0);
    }
  }

  const out: SessionSnapshot[] = [];
  for (const s of store.sessions.values()) {
    const hubOwned = hubOwnedIds.has(s.id);
    let live = openIds.has(s.id) || hubOwned;
    // Historical (non-live) sessions with no events are legitimately empty
    // and stay hidden. Live sessions are always shown.
    if (s.eventCount === 0 && !live) continue;
    if (!live) {
      const lastTs = s.lastTs ? new Date(s.lastTs).getTime() : 0;
      live = lastTs > 0 && now - lastTs < MTIME_LIVE_WINDOW_MS;
    }
    s.isLive = live;
    s.hubOwned = hubOwned;

    // Apply status-cache override: if the patched statusline has written
    // cost/context numbers for this session, use them regardless of age. A
    // Claude-Code-authored number is always preferable to our token-based
    // estimate — Claude Code computes cost with caching/discount logic that
    // we cannot accurately mirror from the outside.
    const sc = statusCache.get(s.id);
    if (sc) {
      if (sc.costUsd != null) {
        s.costUsd = sc.costUsd;
        s.costExact = true;
        s.costKnown = true;
      }
      if (sc.contextUsedTokens != null) s.contextTokens = sc.contextUsedTokens;
      if (sc.contextUsedPct != null) s.contextPct = sc.contextUsedPct;
      if (sc.modelDisplay) s.modelDisplay = sc.modelDisplay;
      if (sc.modelId) s.model = sc.modelId;
    } else if (live) {
      // Live session but no cache entry yet — Claude Code's status line
      // hasn't rendered since we patched statusline.cjs. Any estimate we
      // compute from raw tokens will be wildly off for long-running sessions
      // (cache read pricing is the dominant factor and Claude Code's internal
      // accounting isn't public). Show "—" and tell the user to touch the
      // Warp to populate the cache.
      s.costExact = false;
      s.costKnown = false;
    } else {
      s.costExact = false;
      s.costKnown = true;
    }

    out.push(snapshotFor(s));
  }
  // Live sessions pinned to the top; within each group, newest activity first.
  // This guarantees all currently-open Warps appear at the start of the grid
  // so the user can pair them 1:1 against their actual terminal windows.
  out.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.lastTs < b.lastTs ? 1 : -1;
  });
  return out;
}

export function getFullSession(id: string): FullSession | null {
  return getStore().sessions.get(id) ?? null;
}

/**
 * Flag a session as blocked on the user (permission prompt / question) and
 * push it to every open hub tab. Called from POST /api/attention, which the
 * Claude Code `Notification` hook curls.
 *
 * `rawId` is the id straight from the hook payload — run through
 * canonicalSessionId so a post-/clear session lands on its existing tile.
 * Falls back to matching cwd, since a very young session may not be in the
 * alias map yet.
 */
export function markAttention(
  rawId: string | null,
  message: string,
  cwd?: string | null,
): string | null {
  const store = getStore();
  let snap: FullSession | undefined;

  if (rawId) snap = store.sessions.get(canonicalSessionId(rawId));
  if (!snap && cwd) {
    for (const s of store.sessions.values()) {
      if (s.cwd === cwd && s.hubOwned) {
        snap = s;
        break;
      }
    }
  }
  if (!snap) return null;

  snap.needsAttention = true;
  snap.attentionMessage = message;
  snap.attentionTs = Date.now();

  store.bus.emit("delta", {
    kind: "events",
    sessionId: snap.id,
    events: [],
    snapshot: snapshotFor(snap),
  } satisfies Delta);

  return snap.id;
}

export type { Delta };
export function subscribe(listener: (d: Delta) => void): () => void {
  const store = getStore();
  store.bus.on("delta", listener);
  return () => store.bus.off("delta", listener);
}
