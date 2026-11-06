// Reads the status-cache files written by the patched ~/.claude/statusline.cjs.
// Each live Claude Code session writes a small JSON file into
// ~/.claude/status-cache/<session-id>.json every time Claude Code renders its
// status line. The file contains the authoritative cost / context / model
// numbers — exactly what Warp displays. Using these is how we get a
// pixel-perfect match instead of our token-based estimate.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { canonicalSessionId } from "./live-detect";

const CACHE_DIR = path.join(os.homedir(), ".claude", "status-cache");
// Cache entries are written by a patched ~/.claude/statusline.cjs every time
// Claude Code renders its status bar. We trust any entry we find because even
// a slightly old Claude-Code-authored number is more accurate than our
// token-based estimate. The `fresh` boolean is kept only as metadata for the
// UI so we can tag very old entries if needed — it does NOT gate the override.
const STALE_MS = 60 * 60 * 1000;

export type StatusCacheEntry = {
  sessionId: string;
  costUsd: number | null;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
  contextUsedPct: number | null;
  modelId: string | null;
  modelDisplay: string | null;
  cwd: string | null;
  backgroundTasks: number;
  ts: number;
  fresh: boolean;
};

type RawCache = {
  sessionId: string;
  costUsd: number | null;
  contextWindow: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    used_percentage?: number;
    remaining_percentage?: number;
  } | null;
  model: { id?: string; display_name?: string } | null;
  cwd: string | null;
  backgroundTasks: number;
  ts: number;
};

// Persist the parsed map across Next.js Fast Refresh so the store doesn't flap.
const KEY = Symbol.for("claude-session-browser.status-cache");
type G = typeof globalThis & { [KEY]?: Map<string, StatusCacheEntry> };
const g = globalThis as G;
if (!g[KEY]) g[KEY] = new Map();

function readCacheFile(file: string): StatusCacheEntry | null {
  let raw: RawCache;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawCache;
  } catch {
    return null;
  }
  if (!raw.sessionId) return null;

  const cw = raw.contextWindow || {};
  const maxTokens = cw.context_window_size ?? null;
  const usedPct = cw.used_percentage ?? null;
  // Match statusline.cjs's own formula: if Claude Code has provided a
  // pre-calculated percentage, derive tokens from percent × maxTokens
  // (that's exactly what Warp displays). Otherwise fall back to summing
  // the raw token fields, which can over-count.
  let usedTokens: number;
  if (usedPct != null && maxTokens != null && maxTokens > 0) {
    usedTokens = Math.trunc((maxTokens * usedPct) / 100);
  } else {
    const totalInput = cw.total_input_tokens ?? 0;
    const totalOutput = cw.total_output_tokens ?? 0;
    const cacheRead = cw.current_usage?.cache_read_input_tokens ?? 0;
    usedTokens = totalInput + totalOutput + cacheRead;
  }

  return {
    sessionId: raw.sessionId,
    costUsd: raw.costUsd,
    contextUsedTokens: usedTokens > 0 ? usedTokens : null,
    contextMaxTokens: maxTokens,
    contextUsedPct: usedPct,
    modelId: raw.model?.id ?? null,
    modelDisplay: raw.model?.display_name ?? null,
    cwd: raw.cwd,
    backgroundTasks: raw.backgroundTasks ?? 0,
    ts: raw.ts ?? 0,
    fresh: Date.now() - (raw.ts ?? 0) < STALE_MS,
  };
}

/** Refresh the in-memory map from disk. Called by the store on demand.
 *  Entries are keyed by canonical sessionId so that a /clear-induced id
 *  change still lands on the original tile. The most recent raw entry
 *  wins when multiple aliases point at the same canonical. */
export function refreshStatusCache(): Map<string, StatusCacheEntry> {
  const map = g[KEY]!;
  map.clear();
  let entries: string[];
  try {
    entries = fs.readdirSync(CACHE_DIR);
  } catch {
    return map;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const entry = readCacheFile(path.join(CACHE_DIR, name));
    if (!entry) continue;
    const key = canonicalSessionId(entry.sessionId);
    const existing = map.get(key);
    if (existing && existing.ts >= entry.ts) continue;
    map.set(key, entry);
  }
  return map;
}

export function getStatusCacheSync(): Map<string, StatusCacheEntry> {
  return g[KEY]!;
}

export function getStatusForSession(id: string): StatusCacheEntry | null {
  const map = g[KEY]!;
  return map.get(id) ?? map.get(canonicalSessionId(id)) ?? null;
}
