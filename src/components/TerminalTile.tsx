"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { SessionSnapshot, TimelineEvent } from "@/lib/types";
import { EventStream } from "./EventStream";

// Per-session user label, persisted in localStorage. Lets the user name
// each tile (e.g. "yscapp", "spaleszn", "trading") so they don't have to
// decode the cwd to figure out which project a console belongs to.
const TILE_LABEL_KEY = (sessionId: string) => `tile-label:${sessionId}`;

function useTileLabel(sessionId: string): [string, (next: string) => void] {
  const [label, setLabelState] = useState<string>("");

  useEffect(() => {
    try {
      const v = localStorage.getItem(TILE_LABEL_KEY(sessionId));
      if (v != null) setLabelState(v);
    } catch {
      // localStorage unavailable (private mode, etc.) — degrade silently.
    }
  }, [sessionId]);

  // Cross-tab sync: if the same session is open in two windows and the
  // user renames it in one, the other should pick up the change.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TILE_LABEL_KEY(sessionId)) return;
      setLabelState(e.newValue ?? "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [sessionId]);

  const setLabel = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      setLabelState(trimmed);
      try {
        if (trimmed) localStorage.setItem(TILE_LABEL_KEY(sessionId), trimmed);
        else localStorage.removeItem(TILE_LABEL_KEY(sessionId));
      } catch {
        // ignore
      }
    },
    [sessionId],
  );

  return [label, setLabel];
}

function formatContext(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function shortCwd(cwd: string): string {
  const home = "/Users/";
  if (!cwd.startsWith(home)) return cwd;
  // /Users/foo/bar/baz -> ~/bar/baz
  const parts = cwd.slice(home.length).split("/");
  if (parts.length <= 1) return `~`;
  return "~/" + parts.slice(1).join("/");
}

function durationSince(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function contextPct(
  exact: number | null,
  tokens: number,
  cap = 1_000_000,
): number {
  // Prefer the exact percentage Claude Code itself reports; fall back to a
  // ratio derived from our computed token count.
  if (exact != null) return Math.min(100, Math.max(0, exact));
  return Math.min(100, Math.max(0, (tokens / cap) * 100));
}

function permissionBadge(mode: string | null): {
  label: string;
  color: string;
} | null {
  if (!mode) return null;
  switch (mode) {
    case "bypassPermissions":
      return { label: "bypass", color: "text-term-amber" };
    case "acceptEdits":
      return { label: "accept edits", color: "text-term-cyan" };
    case "plan":
      return { label: "plan mode", color: "text-term-violet" };
    case "default":
      return { label: "ask", color: "text-ink-muted" };
    default:
      return { label: mode, color: "text-ink-muted" };
  }
}

export function TerminalTile({
  session,
  recent,
  onHide,
}: {
  session: SessionSnapshot;
  recent: TimelineEvent[];
  // Hide the tile from the grid (client-side only — the PTY keeps running).
  onHide?: () => void;
}) {
  // Optimistic user messages: the moment the user hits Send, we push
  // their text into `pending` so it shows in the preview immediately.
  // The real event then arrives via JSONL → SSE some fraction of a
  // second later — we dedup by matching trimmed text, and drop any
  // pending entry whose twin has landed. An auto-expire sweep removes
  // stragglers after 30s so a missed match can't leave a ghost.
  const [pending, setPending] = useState<TimelineEvent[]>([]);
  const mergedRecent = useMemo(() => {
    if (pending.length === 0) return recent;
    const realUserTexts = new Set<string>();
    for (const ev of recent) {
      if (ev.kind === "user" && ev.text) realUserTexts.add(ev.text.trim());
    }
    const keep = pending.filter((p) => !realUserTexts.has((p.text ?? "").trim()));
    return keep.length === 0 ? recent : [...recent, ...keep];
  }, [recent, pending]);
  useEffect(() => {
    if (pending.length === 0) return;
    const realUserTexts = new Set<string>();
    for (const ev of recent) {
      if (ev.kind === "user" && ev.text) realUserTexts.add(ev.text.trim());
    }
    const now = Date.now();
    setPending((prev) =>
      prev.filter(
        (p) =>
          !realUserTexts.has((p.text ?? "").trim()) &&
          now - new Date(p.ts).getTime() < 30_000,
      ),
    );
  }, [recent, pending.length]);
  const pushPending = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setPending((prev) => [
      ...prev,
      {
        kind: "user",
        ts: new Date().toISOString(),
        uuid: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: t,
      },
    ]);
  }, []);
  const router = useRouter();
  const perm = permissionBadge(session.permissionMode);
  const ctxPct = contextPct(session.contextPct, session.contextTokens);
  const [tileLabel, setTileLabel] = useTileLabel(session.id);
  const [hovered, setHovered] = useState(false);
  const [tileDragOver, setTileDragOver] = useState(false);
  const tileDrop = useRef<((file: File) => void) | null>(null);

  // Waiting state with optimistic clear: the server-reported
  // `waitingForInput` flips based on JSONL stop_reason, which lags our
  // just-sent input. While we have a pending optimistic message, treat
  // the session as thinking — the user just dispatched work.
  const effectiveWaiting = session.waitingForInput && pending.length === 0;

  // Blocked on a permission prompt. Same optimistic clear: if we just sent
  // input, the answer is in flight.
  const needsAttention = session.needsAttention && pending.length === 0;

  // Thinking timer: track how long Claude has been working.
  const thinkingStartRef = useRef<number | null>(null);
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  const isThinking = session.isLive && !effectiveWaiting && !needsAttention;
  useEffect(() => {
    if (isThinking) {
      if (!thinkingStartRef.current) thinkingStartRef.current = Date.now();
      const id = setInterval(() => {
        setThinkingElapsed(Math.floor((Date.now() - (thinkingStartRef.current ?? Date.now())) / 1000));
      }, 1000);
      return () => clearInterval(id);
    } else {
      thinkingStartRef.current = null;
      setThinkingElapsed(0);
    }
  }, [isThinking]);
  // Smart routing:
  //  - HUB-OWNED live tile: pty-server is holding the PTY for us, so we
  //    can safely reattach the interactive xterm. The body click no
  //    longer navigates — instead the inline input bar lets the user
  //    type a message in place, and a small ↗ button opens the full
  //    /live/<id> view if they need a real terminal.
  //  - WARP-OWNED live tile: a real Warp window has claude attached to
  //    this JSONL. Spawning a second claude --resume on the same id
  //    would race / corrupt — open the read-only mirror instead.
  //  - DEAD tile: historical session, no running claude. Clicking opens
  //    /live/ to spawn a fresh `claude --resume <id>`.
  const isInteractive = session.isLive && session.hubOwned;
  // Sessions whose JSONL lives under ~/.claude-alt are "claude2" sessions
  // (separate config dir => separate Anthropic account). The flavor MUST
  // ride along in the /live link: without it the spawn falls back to the
  // default ~/.claude config, which resumes the wrong account and can't
  // even find the transcript ("No conversation found with session ID").
  const tileFlavor = session.projectDir?.startsWith("alt::") ? "claude2" : "claude";
  const href =
    session.isLive && !session.hubOwned
      ? `/s/${session.id}`
      : `/live/${session.id}?flavor=${tileFlavor}`;

  const onOpen = () => router.push(href);
  const onTileClick = () => {
    // Hub-owned tiles handle interaction in place via QuickInputBar.
    // Don't navigate on body click — the user explicitly opens the
    // full terminal via the ↗ button.
    if (isInteractive) return;
    router.push(href);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Don't handle space on live tiles — push-to-talk uses it.
    if (e.key === " " && session.isLive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (isInteractive) return;
      router.push(href);
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onTileClick}
      onKeyDown={onKey}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTileDragOver(false); }}
      onDragOver={(e) => { e.preventDefault(); setTileDragOver(true); }}
      onDragLeave={(e) => {
        // Only clear if leaving the tile entirely (not entering a child).
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setTileDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setTileDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file && file.type.startsWith("image/") && tileDrop.current) {
          tileDrop.current(file);
        }
      }}
      aria-label={`Open session ${session.id}`}
      className={`tile noise group relative flex h-[420px] flex-col overflow-hidden rounded-[14px] bg-bg-terminal shadow-tile hover:shadow-tileHover focus:outline-none focus:ring-1 focus:ring-term-violet/60 ${
        isInteractive ? "" : "cursor-pointer"
      } ${
        needsAttention && session.isLive
          ? "tile-attention"
          : effectiveWaiting && session.isLive
            ? "tile-waiting"
            : session.isLive
              ? "tile-live"
              : ""
      }`}
    >
      {/* ── Warp header ─────────────────────────────────────────────── */}
      {/* cwd lives inline next to the traffic lights now (was absolutely
          centered, which collided with the WAITING badge on the right).
          Project label badge removed per user request. */}
      <div className="flex h-[34px] shrink-0 items-center gap-3 border-b border-edge/70 bg-bg-header px-3">
        {/* traffic lights */}
        <div className="flex shrink-0 items-center gap-[6px]">
          <span className="h-[11px] w-[11px] rounded-full bg-[#ff5f57] ring-1 ring-black/40" />
          {/* Yellow = minimize, like macOS: hides the tile, session keeps running. */}
          {onHide ? (
            <button
              type="button"
              title="Hide console (keeps running — unhide from the header)"
              aria-label="Hide console"
              onClick={(e) => {
                e.stopPropagation();
                onHide();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="flex h-[11px] w-[11px] items-center justify-center rounded-full bg-[#febc2e] text-[9px] font-bold leading-none text-black/0 ring-1 ring-black/40 hover:text-black/70"
            >
              –
            </button>
          ) : (
            <span className="h-[11px] w-[11px] rounded-full bg-[#febc2e] ring-1 ring-black/40" />
          )}
          <span className="h-[11px] w-[11px] rounded-full bg-[#28c840] ring-1 ring-black/40" />
        </div>

        {/* Editable per-session name. The user wants to set every title
            themselves — no auto-fill from cwd — so unnamed tiles show a
            faint "name this console" prompt instead. The full cwd is
            still available in the title tooltip. */}
        <EditableName
          label={tileLabel}
          cwd={session.cwd}
          onChange={setTileLabel}
        />

        {/* top-right: waiting badge + started-at */}
        <div className="flex shrink-0 items-center gap-1.5">
          {session.isLive && needsAttention && (
            <span
              title={session.attentionMessage ?? undefined}
              className="flex items-center gap-1 rounded-[5px] border border-[#ff5f57]/80 bg-[#ff5f57]/20 px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-wider text-[#ff8a85]"
            >
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[#ff5f57]" />
              needs you
            </span>
          )}
          {session.isLive && effectiveWaiting && !needsAttention && (
            <span className="flex items-center gap-1 rounded-[5px] border border-term-amber/70 bg-term-amber/15 px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-wider text-term-amber">
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-term-amber" />
              waiting
            </span>
          )}
          {isThinking && (
            <span className="flex items-center gap-1 rounded-[5px] border border-term-cyan/70 bg-term-cyan/15 px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-wider text-term-cyan">
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-term-cyan" />
              {thinkingElapsed}s
            </span>
          )}
          <span className="text-[9.5px] text-ink-faint">
            {session.isLive ? "started" : "last"} {durationSince(session.firstTs ?? session.lastTs)}
          </span>
        </div>
      </div>

      {/* ── Terminal body ───────────────────────────────────────────── */}
      {/* Scrollable: pinned to the bottom by default, follows new events
          while the user is at the bottom, and stays put if they've
          scrolled up to look at history. */}
      <ScrollableBody recent={mergedRecent} live={session.isLive} />

      {/* ── Claude Code status footer ───────────────────────────────── */}
      <div className="relative shrink-0 border-t border-edge/70 bg-bg-header/90 backdrop-blur-[2px]">
        {/* row 1: model + context bar + cost */}
        <div className="flex items-center gap-3 px-3 pt-2 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${session.isLive ? "animate-pulse-soft bg-term-green" : "bg-ink-faint"}`}
            />
            <span className="font-medium text-ink">
              {session.modelDisplay}
            </span>
            <span className="text-ink-faint">(1M context)</span>
          </span>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-ink-muted">
              {formatContext(session.contextTokens)}
            </span>
            <div className="h-1.5 w-[88px] overflow-hidden rounded-full bg-bg-hover ring-1 ring-edge">
              <div
                className="h-full rounded-full bg-gradient-to-r from-term-green via-term-cyan to-term-violet"
                style={{ width: `${ctxPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* row 2: permission mode + hint */}
        <div className="flex items-center gap-3 px-3 pb-2 pt-1 text-[10px]">
          {perm ? (
            <span className={`uppercase tracking-wider ${perm.color}`}>
              ⏵⏵ {perm.label} permissions
            </span>
          ) : (
            <span className="uppercase tracking-wider text-ink-faint">
              ⏵ default permissions
            </span>
          )}
          <span className="text-ink-faint">shift+tab to cycle</span>

          <span className="ml-auto text-ink-faint">
            {session.eventCount} events
          </span>
        </div>
      </div>

      {/* Permission prompts removed from overview — they show stale state
          and the sessions proceed without manual approval anyway. Users can
          open the full /live/ view if they need to handle a real permission. */}

      {/* Inline input bar — always mounted so attachments survive liveness
          flickers. Hidden visually when session is dead. */}
      {/* Drop overlay */}
      {tileDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] border-2 border-dashed border-term-violet bg-term-violet/10">
          <span className="text-sm font-medium text-term-violet">Drop screenshot here</span>
        </div>
      )}

      <QuickInputBar sessionId={session.id} onOpenFull={onOpen} hubOwned={session.hubOwned} tileHovered={hovered} onDropFile={tileDrop} onOptimisticSend={pushPending} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ScrollableBody
//
// Tile body that lets the user scroll back through the recent event
// history. New events auto-stick the view to the bottom unless the
// user has scrolled up to look at older history — then we leave their
// scroll position alone so we don't yank them away mid-read.
function ScrollableBody({
  recent,
  live,
}: {
  recent: TimelineEvent[];
  live: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user is currently pinned to the bottom. We update
  // this on each scroll event and consult it before auto-scrolling on
  // new content.
  const stickToBottomRef = useRef(true);

  // Initial render: jump straight to the bottom so the newest event is
  // visible without the user having to scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial render: jump to bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll on new content, but only if the user hasn't scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Top gradient fade for "scrollback" feel */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-bg-terminal to-transparent" />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // Stop click + key propagation so scrolling/clicking inside the
        // history area doesn't trigger the surrounding tile's navigate
        // handler. Mouse-wheel events don't fire onClick anyway.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-3"
      >
        <EventStream events={recent} dense />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// EditableName
//
// In-place editable label for a tile. Shows the user-set name, or the
// cwd as a fallback. Click to edit, Enter saves, Esc cancels, blank
// clears the override and reverts to the cwd.
function EditableName({
  label,
  cwd,
  onChange,
}: {
  label: string;
  cwd: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(label);
      // Focus + select on next tick so the user can immediately type
      // over whatever was there.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, label]);

  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

  const commit = () => {
    onChange(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(label);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={stop}
        onMouseDown={stop}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={commit}
        placeholder="name this console…"
        className="min-w-0 flex-1 rounded-[4px] border border-term-violet/50 bg-bg-panel/80 px-1.5 py-[2px] text-[11.5px] text-ink outline-none placeholder:text-ink-faint focus:border-term-violet"
      />
    );
  }

  const hasName = label.length > 0;
  return (
    <button
      type="button"
      title={hasName ? `${label} — ${cwd}` : cwd}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onMouseDown={stop}
      className={`group/name min-w-0 flex-1 truncate rounded-[4px] px-1 py-[1px] text-left text-[11.5px] hover:bg-white/5 ${
        hasName ? "font-medium text-ink" : "italic text-ink-faint"
      }`}
    >
      {hasName ? label : "+ name this console"}
      <span className="ml-1.5 text-[9px] text-ink-faint opacity-0 transition group-hover/name:opacity-100">
        ✎
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// QuickInputBar
//
// A small text input + send button + ↗ "open full terminal" link that
// appears at the bottom of hub-owned live tiles. Pressing Enter posts
// the text (plus a carriage return so claude treats it as a submitted
// message) to /api/pty-input, which writes it directly to the PTY's
// stdin. No WebSocket needed — every message is a single fire-and-forget
// HTTP call.
function QuickInputBar({
  sessionId,
  onOpenFull,
  hubOwned,
  tileHovered,
  onDropFile,
  onOptimisticSend,
}: {
  sessionId: string;
  onOpenFull: () => void;
  hubOwned: boolean;
  tileHovered: boolean;
  onDropFile: React.MutableRefObject<((file: File) => void) | null>;
  onOptimisticSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<unknown>(null);
  // Attachments are stored separately from the text so the long temp-file
  // paths don't fill the input box. They render as compact chips above
  // the text field, and get appended to the message at send time.
  const [attachments, setAttachments] = useState<string[]>([]);
  // Two-click arm for the reset (↻) button — one click primes "sure?",
  // second click kills claude and respawns fresh (same tile, new session).
  // Auto-disarms after 2s so a stray click doesn't wipe context.
  const [clearArmed, setClearArmed] = useState(false);
  const clearArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendClear = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      if (clearArmTimer.current) clearTimeout(clearArmTimer.current);
      clearArmTimer.current = setTimeout(() => setClearArmed(false), 2000);
      return;
    }
    if (clearArmTimer.current) {
      clearTimeout(clearArmTimer.current);
      clearArmTimer.current = null;
    }
    setClearArmed(false);
    // /api/pty-reset only makes sense for hub-owned sessions (we have a PTY
    // to kill). For non-hub Warps, fall back to the old /clear behavior so
    // the button still does *something* — even if it spawns a new session
    // client-side.
    if (!hubOwned) {
      try {
        await fetch("/api/warp-input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, data: "/clear\r" }),
        });
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    try {
      const r = await fetch("/api/pty-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const body = (await r.json().catch(() => null)) as {
        ok?: boolean;
        primer?: string;
        error?: string;
      } | null;
      if (!r.ok || !body?.ok) {
        setError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      // Drop the primer into the input box so the user can review (and
      // optionally edit) before sending. The freshly-restarted claude will
      // be ready for input within a couple seconds.
      if (body.primer) {
        setText(body.primer);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Send a message to the session. Accepts an optional explicit message
  // so callers (e.g. push-to-talk auto-send) can bypass React state.
  // Always sends immediately — the PTY buffers input while claude is busy.
  const send = async (explicitText?: string) => {
    const trimmed = (explicitText ?? text).trim();
    if ((!trimmed && attachments.length === 0) || sending) return;
    setError(null);
    setSending(true);
    const parts: string[] = [];
    if (trimmed) parts.push(trimmed);
    for (const p of attachments) {
      parts.push(`[screenshot image: "${p}"]`);
    }
    const data = parts.join(" ") + "\r";
    setText("");
    setAttachments([]);
    // Fire optimistic render so the tile shows "> <your text>" in green
    // immediately, without waiting for the JSONL → SSE round trip.
    if (trimmed) onOptimisticSend(trimmed);

    const endpoint = hubOwned ? "/api/pty-input" : "/api/warp-input";
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, data }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // Ref so PTT callback (stable closure) can call the latest send().
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });

  // Snapshot of text at the moment mic starts — new speech appends after it.
  const prefixRef = useRef("");

  // Web Speech API: toggle mic on/off for voice-to-text input.
  // Re-activating the mic appends to whatever text is already there.
  const toggleMic = useCallback(() => {
    if (listening) {
      (recognitionRef.current as { stop: () => void } | null)?.stop();
      setListening(false);
      return;
    }
    const SR =
      (window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    if (!SR) {
      setError("Speech not supported in this browser");
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition = new (SR as any)() as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: ((e: { results: { length: number; [i: number]: { isFinal?: boolean; 0: { transcript: string } } } }) => void) | null;
      onend: (() => void) | null;
      onerror: ((ev: { error?: string }) => void) | null;
      start: () => void;
      stop: () => void;
    };
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    // Capture current text so new speech appends after it.
    prefixRef.current = text + (text && !text.endsWith(" ") ? " " : "");
    // Track finalized transcript segments so we only rewrite the latest
    // interim chunk — avoids the full-text flicker from rewriting everything.
    let finalizedSoFar = "";
    recognition.onresult = (e) => {
      let finalPart = "";
      let interimPart = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          finalPart += r[0].transcript;
        } else {
          interimPart += r[0].transcript;
        }
      }
      finalizedSoFar = finalPart;
      setText(prefixRef.current + finalizedSoFar + interimPart);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = (ev: { error?: string }) => {
      setListening(false);
      const code = ev?.error ?? "unknown";
      if (code === "not-allowed") {
        setError("Mic blocked — check browser permissions");
      } else if (code !== "no-speech" && code !== "aborted") {
        setError(`Mic error: ${code}`);
      }
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, text]);

  // Push-to-talk: hold spacebar while hovering over the tile to record.
  // Release to stop. Only activates when the textarea isn't focused.
  // Uses refs so the global listener is registered once and stays stable.
  const pushToTalkRef = useRef(false);
  const listeningRef = useRef(false);
  const hoveredRef = useRef(tileHovered);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => { hoveredRef.current = tileHovered; }, [tileHovered]);

  // MediaRecorder for Groq Whisper: records audio alongside the browser's
  // Web Speech API. On release, the audio blob is sent to /api/transcribe
  // for a high-quality Whisper transcript that replaces the browser one.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Incremented on every press AND release. getUserMedia resolves async, so a
  // quick tap-release could otherwise start a recorder AFTER the release — it
  // then runs forever and its chunks interleave with the next recording's,
  // producing a corrupt webm that Groq rejects ("could not process file").
  const pttTokenRef = useRef(0);
  const audioChunksRef = useRef<Blob[]>([]);
  const pttSnapshotRef = useRef("");

  const [transcribing, setTranscribing] = useState(false);

  const startPTT = useCallback(() => {
    if (listeningRef.current) return;

    pttSnapshotRef.current = text + (text && !text.endsWith(" ") ? " " : "");

    setListening(true);
    listeningRef.current = true;

    // Record audio via MediaRecorder → Groq Whisper on release.
    audioChunksRef.current = [];
    const token = ++pttTokenRef.current;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      if (token !== pttTokenRef.current || !listeningRef.current) {
        // Released (or re-pressed) before the mic came up — never start.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start(250); // collect chunks every 250ms for faster stop
      mediaRecorderRef.current = mr;
    }).catch(() => {
      setError("Mic blocked — check browser permissions");
      setListening(false);
      listeningRef.current = false;
    });
  }, [text]);
  const startPTTRef = useRef(startPTT);
  useEffect(() => { startPTTRef.current = startPTT; }, [startPTT]);

  // Called when space is released — stop recording, send to Whisper,
  // replace text with the accurate transcript.
  const stopPTTAndTranscribe = useCallback(() => {
    setListening(false);
    listeningRef.current = false;
    pttTokenRef.current++; // invalidate any in-flight getUserMedia

    const mr = mediaRecorderRef.current;
    if (!mr || mr.state === "inactive") return;

    mr.onstop = async () => {
      mr.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      audioChunksRef.current = [];
      if (blob.size < 500) return; // too short

      setTranscribing(true);
      try {
        const fd = new FormData();
        fd.append("file", blob, "audio.webm");
        const r = await fetch("/api/transcribe", { method: "POST", body: fd });
        if (r.ok) {
          const { text: t } = (await r.json()) as { text: string };
          if (t.trim()) setText(pttSnapshotRef.current + t.trim());
        } else {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `transcribe HTTP ${r.status}`);
        }
      } catch (e) {
        setError(`transcribe: ${(e as Error).message}`);
      } finally {
        setTranscribing(false);
      }
    };
    mr.stop();
  }, []);
  const stopPTTAndTranscribeRef = useRef(stopPTTAndTranscribe);
  useEffect(() => { stopPTTAndTranscribeRef.current = stopPTTAndTranscribe; }, [stopPTTAndTranscribe]);

  // Push-to-talk: two modes depending on where focus is.
  //
  // A) Textarea focused (user is typing): hold-detect with 300ms threshold.
  //    Space types instantly (zero lag). If held > 300ms, remove the extra
  //    space and start PTT. Quick taps are just normal spaces.
  //
  // B) Textarea NOT focused (just hovering over tile): start PTT immediately
  //    on space-down, preventDefault to stop page scroll. No delay needed
  //    since there's no text input to conflict with.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spaceDownElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const HOLD_MS = 300;

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (!hoveredRef.current) return;
      const el = document.activeElement;
      const tag = (el?.tagName ?? "").toLowerCase();
      const isXterm = el?.classList.contains("xterm-helper-textarea");
      if (tag === "input" && !isXterm) return;
      if (listeningRef.current) return;

      const isTextarea = tag === "textarea" && !isXterm;

      if (!isTextarea) {
        // Mode B: no textarea focused — start PTT immediately.
        e.preventDefault();
        pushToTalkRef.current = true;
        startPTTRef.current();
        return;
      }

      // Mode A: textarea focused — hold detection. Let the space type
      // instantly (no preventDefault). If held, clean up and start PTT.
      spaceDownElRef.current = el as HTMLElement;

      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        const ta = spaceDownElRef.current as HTMLTextAreaElement | null;
        if (ta && ta.tagName === "TEXTAREA") {
          const val = ta.value;
          if (val.endsWith(" ")) {
            const nativeSet = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype, "value",
            )?.set;
            if (nativeSet) {
              nativeSet.call(ta, val.replace(/ +$/, ""));
              ta.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          ta.blur();
        }
        spaceDownElRef.current = null;
        pushToTalkRef.current = true;
        startPTTRef.current();
      }, HOLD_MS);
    };

    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.code !== "Space") return;

      // Mode A quick tap — cancel hold timer. Space already typed.
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        spaceDownElRef.current = null;
        return;
      }

      // PTT was active (either mode) — stop recording and send to Whisper.
      if (!pushToTalkRef.current) return;
      pushToTalkRef.current = false;
      stopPTTAndTranscribeRef.current();
      // Focus the textarea so the user can press Enter to send immediately.
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };
  }, []);

  // Handle clipboard image paste: upload the blob to /api/paste-image
  // and append the resulting file path to the attachments list. The
  // text input stays clean so the user can keep typing.
  const handleImagePaste = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/paste-image", { method: "POST", body: fd });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      const { path } = (await r.json()) as { path: string };
      setAttachments((prev) => [...prev, path]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }, []);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      e.preventDefault();
      e.stopPropagation();
      const file = item.getAsFile();
      if (!file) return;
      void handleImagePaste(file);
      return;
    }
  };

  // Global paste handler: catches Cmd+V even when textarea isn't focused
  // (e.g. during push-to-talk). Only activates when hovering over this tile.
  const handleImagePasteRef = useRef(handleImagePaste);
  useEffect(() => { handleImagePasteRef.current = handleImagePaste; }, [handleImagePaste]);
  useEffect(() => {
    const onGlobalPaste = (e: ClipboardEvent) => {
      if (!hoveredRef.current) return;
      // Don't intercept if textarea is focused — the React handler will fire.
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        void handleImagePasteRef.current(file);
        return;
      }
    };
    document.addEventListener("paste", onGlobalPaste);
    return () => document.removeEventListener("paste", onGlobalPaste);
  }, []);

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  // File picker ref: backup path when clipboard paste doesn't work.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith("image/")) {
      void handleImagePaste(file);
    }
    // Reset so the same file can be picked again.
    e.target.value = "";
  };

  // Register the drop handler so the parent tile can forward dropped files.
  useEffect(() => {
    onDropFile.current = (file: File) => void handleImagePaste(file);
    return () => { onDropFile.current = null; };
  }, [handleImagePaste, onDropFile]);

  // Explicit clipboard read: bypasses paste events entirely. Works even
  // when the textarea isn't focused or the tile isn't hovered.
  const pasteFromClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const file = new File([blob], "clipboard.png", { type: imageType });
          void handleImagePaste(file);
          return;
        }
      }
      setError("no image in clipboard");
    } catch (err) {
      setError(`clipboard: ${(err as Error).message}`);
    }
  }, [handleImagePaste]);

  // Auto-grow the textarea whenever text changes (mic or keyboard).
  // Uses overflow trick instead of height=auto to avoid collapse→expand flicker.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Temporarily shrink to measure natural content height without flicker.
    el.style.overflow = "hidden";
    el.style.height = "0";
    const scrollH = el.scrollHeight;
    el.style.height = `${Math.min(scrollH, 120)}px`;
    el.style.overflow = scrollH > 120 ? "auto" : "hidden";
  }, [text]);

  // Drag-and-drop: accept image files dragged onto the input bar.
  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      void handleImagePaste(file);
    }
  };

  // Stop propagation on every event we handle inside this bar so the
  // surrounding tile's click/key handler doesn't fire (which would
  // navigate or re-focus things).
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

  return (
    <div
      className={`flex shrink-0 flex-col gap-1.5 border-t bg-bg-header/95 px-3 py-2 ${
        dragOver
          ? "border-term-violet border-dashed bg-term-violet/10"
          : "border-edge/70"
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={stop}
      onMouseDown={stop}
    >
      {/* Attachment chips: each pasted screenshot becomes a compact pill
          showing just the basename, with an × to remove. The full path
          is in the title tooltip and gets appended to the message at
          send time. */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {attachments.map((p, i) => {
            const name = p.split("/").pop() ?? p;
            return (
              <span
                key={`${p}#${i}`}
                title={p}
                className="flex max-w-[180px] items-center gap-1 rounded-[5px] border border-term-violet/50 bg-term-violet/10 px-1.5 py-[2px] text-[10px] text-term-violet"
              >
                <span className="text-[11px] leading-none">📎</span>
                <span className="truncate">{name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAttachment(i);
                  }}
                  className="ml-0.5 text-ink-faint hover:text-term-red"
                  aria-label="remove attachment"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="flex items-end gap-2">
      <textarea
        ref={textareaRef}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => void onPaste(e)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={
          error
            ? `× ${error}`
            : transcribing
              ? "transcribing…"
              : uploading
                ? "uploading screenshot…"
                : listening
                  ? "🎤 listening…"
                  : attachments.length > 0
                    ? "add a message (optional) and press enter…"
                    : "hold space to talk — or type a message…"
        }
        disabled={sending}
        className={`flex-1 resize-none bg-transparent text-[12px] leading-[1.5] outline-none placeholder:text-ink-faint ${
          listening ? "text-term-red" : error ? "text-term-red" : "text-term-user"
        }`}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void pasteFromClipboard();
        }}
        disabled={uploading}
        title="Paste screenshot from clipboard"
        className="rounded-[5px] border border-edge bg-bg-panel/80 px-2 py-[3px] text-[11px] leading-none text-ink-muted hover:border-term-violet/60 hover:text-term-violet disabled:opacity-30"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onFilePick}
        className="hidden"
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void send();
        }}
        disabled={(!text.trim() && attachments.length === 0) || sending}
        className="rounded-[5px] border border-term-violet/60 bg-term-violet/10 px-2 py-[3px] text-[10px] font-medium uppercase tracking-wider text-term-violet hover:bg-term-violet/20 disabled:cursor-not-allowed disabled:opacity-30"
      >
        send
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          toggleMic();
        }}
        title={listening ? "Stop recording" : "Voice input"}
        className={`rounded-[5px] border px-2 py-[3px] text-[11px] leading-none ${
          listening
            ? "animate-pulse-soft border-term-red/60 bg-term-red/10 text-term-red"
            : "border-edge bg-bg-panel/80 text-ink-muted hover:border-term-violet/60 hover:text-term-violet"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void sendClear();
        }}
        title={
          clearArmed
            ? "Click again to confirm — wipes claude's context"
            : "Reset context (/clear)"
        }
        className={`rounded-[5px] border px-2 py-[3px] text-[11px] leading-none ${
          clearArmed
            ? "animate-pulse-soft border-term-amber/70 bg-term-amber/20 text-term-amber"
            : "border-edge bg-bg-panel/80 text-ink-muted hover:border-term-amber/60 hover:text-term-amber"
        }`}
      >
        {clearArmed ? "sure?" : "↻"}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenFull();
        }}
        title="Open full terminal"
        className="rounded-[5px] border border-edge bg-bg-panel/80 px-2 py-[3px] text-[12px] leading-none text-ink-muted hover:border-term-violet/60 hover:text-term-violet"
      >
        ↗
      </button>
      </div>
    </div>
  );
}
