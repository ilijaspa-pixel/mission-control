// Client-side helpers shared by the console shell (sidebar + Grok chat).
// Storage keys intentionally match the hub grid (TerminalTile / HubClient)
// so names and hidden state carry over between /grid and the shell.

import type { SessionSnapshot } from "./types";

export const TILE_LABEL_KEY = (id: string) => `tile-label:${id}`;
export const HIDDEN_TILES_KEY = "mc-hidden-tiles";
export const TERMINAL_TOGGLE_KEY = (id: string) => `mc-live-terminal:${id}`;
export const SIDEBAR_KEY = "mc-shell-sidebar";

export function readLabel(id: string): string {
  try {
    return localStorage.getItem(TILE_LABEL_KEY(id)) ?? "";
  } catch {
    return "";
  }
}

export function writeLabel(id: string, next: string): void {
  const t = next.trim();
  try {
    if (t) localStorage.setItem(TILE_LABEL_KEY(id), t);
    else localStorage.removeItem(TILE_LABEL_KEY(id));
  } catch {}
}

export function readHidden(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_TILES_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeHidden(ids: string[]): void {
  try {
    localStorage.setItem(HIDDEN_TILES_KEY, JSON.stringify(ids));
  } catch {}
}

function cleanTitle(t: string): string {
  return t
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .replace(/<[^>]*\/?>/g, " ")
    .replace(/\[screenshot image:[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fallback name when the user hasn't labelled the console. */
export function fallbackName(s: SessionSnapshot): string {
  const first = s.firstUserMessage ? cleanTitle(s.firstUserMessage) : "";
  if (first && !first.startsWith("Caveat:")) return first.slice(0, 80);
  const base = (s.cwd ?? "").split(/[\\/]/).filter(Boolean).pop();
  return base || s.projectLabel || s.id.slice(0, 8);
}

export function flavorOf(s: Pick<SessionSnapshot, "projectDir">): "claude" | "claude2" {
  return s.projectDir?.startsWith("alt::") ? "claude2" : "claude";
}

export type ConsoleStatus = "needs" | "waiting" | "working" | "idle";

// Same signals as the hub tile badges (NEEDS YOU / WAITING / thinking).
// An attention ping that arrives after the turn already ended (end_turn) is
// Claude Code's idle "waiting for your input" notification, not a blocking
// prompt: that is a reply-wanted (amber), not a needs-the-terminal (red).
export function isBlocked(s: SessionSnapshot): boolean {
  if (!s.needsAttention) return false;
  if (s.waitingForInput) return false;
  if (/waiting for your input/i.test(s.attentionMessage ?? "")) return false;
  return true;
}

export function statusOf(s: SessionSnapshot): ConsoleStatus {
  if (!s.isLive) return "idle";
  if (isBlocked(s)) return "needs";
  if (s.needsAttention) return "waiting";
  if (s.waitingForInput) return "waiting";
  return "working";
}
