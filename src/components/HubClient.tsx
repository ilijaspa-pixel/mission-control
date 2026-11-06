"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot, TimelineEvent } from "@/lib/types";
import { TerminalTile } from "./TerminalTile";

type Delta =
  | { kind: "snapshot"; session: SessionSnapshot }
  | { kind: "events"; sessionId: string; events: TimelineEvent[]; snapshot: SessionSnapshot }
  | { kind: "liveness"; sessionId: string; isLive: boolean }
  | { kind: "evict"; sessionId: string };

type Filter = "all" | "live" | string; // string = project label

const HIDDEN_TILES_KEY = "mc-hidden-tiles";

// Same name the tile shows: the user-set label, else the cwd basename.
function tileName(s: SessionSnapshot): string {
  try {
    const label = localStorage.getItem(`tile-label:${s.id}`);
    if (label) return label;
  } catch {
    // ignore
  }
  const base = (s.cwd ?? "").split("/").filter(Boolean).pop();
  return base || s.id.slice(0, 8);
}

export function HubClient({
  initialSessions,
  initialRecent,
}: {
  initialSessions: SessionSnapshot[];
  initialRecent: Record<string, TimelineEvent[]>;
}) {
  const [sessions, setSessions] = useState<Record<string, SessionSnapshot>>(() => {
    const m: Record<string, SessionSnapshot> = {};
    for (const s of initialSessions) m[s.id] = s;
    return m;
  });
  const [recent, setRecent] = useState<Record<string, TimelineEvent[]>>(initialRecent);
  // Only one view: live sessions. Filters removed per user request —
  // they just want to see active Warps, nothing else.
  const [connected, setConnected] = useState(false);

  // Play a short "ding" when a tile flips from working → waiting, so the
  // user doesn't have to stare at the grid to know Claude just finished.
  // Uses WebAudio (no asset file). Also pokes the tab title so backgrounded
  // windows show an "(N) Mission Control" counter until the tab is focused.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const pendingDingsRef = useRef(0);
  const baseTitleRef = useRef<string>("");
  useEffect(() => {
    baseTitleRef.current = document.title || "Mission Control";
    const onFocus = () => {
      pendingDingsRef.current = 0;
      document.title = baseTitleRef.current;
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const playDing = useCallback(() => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      // Two-tone chime: 880 Hz then 1320 Hz, gentle bell envelope.
      for (const [freq, start] of [[880, 0], [1320, 0.12]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(0.18, now + start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + 0.4);
      }
    } catch {
      // Audio unavailable — silent failure is fine.
    }
  }, []);
  const bumpTabTitle = useCallback(() => {
    if (!document.hidden) return;
    pendingDingsRef.current += 1;
    document.title = `(${pendingDingsRef.current}) ${baseTitleRef.current}`;
  }, []);

  // Prevent space bar from scrolling the page. Push-to-talk uses space,
  // and the browser default scroll-on-space is never wanted on this page.
  useEffect(() => {
    const blockSpaceScroll = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      // Allow normal space in text inputs.
      if (tag === "textarea" || tag === "input") return;
      e.preventDefault();
    };
    window.addEventListener("keydown", blockSpaceScroll);
    return () => window.removeEventListener("keydown", blockSpaceScroll);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("ready", (e: MessageEvent) => {
      setConnected(true);
      // Every connect (including silent EventSource reconnects after a
      // suspended tab / network blip) ships a fresh full snapshot. Replace
      // local state so tiles can't drift permanently off the server truth.
      try {
        const payload = JSON.parse(e.data) as {
          sessions?: SessionSnapshot[];
          recent?: Record<string, TimelineEvent[]>;
        };
        if (Array.isArray(payload.sessions)) {
          const m: Record<string, SessionSnapshot> = {};
          for (const s of payload.sessions) m[s.id] = s;
          setSessions(m);
        }
        if (payload.recent && typeof payload.recent === "object") {
          setRecent(payload.recent);
        }
      } catch {
        // Old-format ready (no payload) — harmless, deltas still flow.
      }
    });
    es.addEventListener("delta", (e: MessageEvent) => {
      let delta: Delta;
      try {
        delta = JSON.parse(e.data);
      } catch {
        return;
      }
      if (delta.kind === "events") {
        setSessions((prev) => {
          const was = prev[delta.sessionId];
          const next = delta.snapshot;
          // Transition: Claude was working, now flipped to waiting =
          // end_turn just landed. Fire the "done" chime + tab-title bump.
          if (
            next.hubOwned &&
            next.isLive &&
            next.waitingForInput &&
            was &&
            !was.waitingForInput
          ) {
            playDing();
            bumpTabTitle();
          }
          // Blocked on a permission prompt. Separate transition from
          // waitingForInput — a stalled session never sets that flag.
          if (
            next.hubOwned &&
            next.isLive &&
            next.needsAttention &&
            was &&
            !was.needsAttention
          ) {
            playDing();
            bumpTabTitle();
          }
          return { ...prev, [delta.sessionId]: next };
        });
        setRecent((prev) => {
          const prevList = prev[delta.sessionId] ?? [];
          // Keep up to 300 events of scrollback per tile so the user
          // can browse history without it growing unbounded.
          const merged = [...prevList, ...delta.events].slice(-300);
          return { ...prev, [delta.sessionId]: merged };
        });
      } else if (delta.kind === "liveness") {
        setSessions((prev) => {
          const s = prev[delta.sessionId];
          if (!s) return prev;
          return { ...prev, [delta.sessionId]: { ...s, isLive: delta.isLive } };
        });
      } else if (delta.kind === "snapshot") {
        setSessions((prev) => {
          const was = prev[delta.session.id];
          const next = delta.session;
          if (
            next.hubOwned &&
            next.isLive &&
            next.waitingForInput &&
            was &&
            !was.waitingForInput
          ) {
            playDing();
            bumpTabTitle();
          }
          if (
            next.hubOwned &&
            next.isLive &&
            next.needsAttention &&
            was &&
            !was.needsAttention
          ) {
            playDing();
            bumpTabTitle();
          }
          return { ...prev, [next.id]: next };
        });
      } else if (delta.kind === "evict") {
        setSessions((prev) => {
          if (!(delta.sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[delta.sessionId];
          return next;
        });
        setRecent((prev) => {
          if (!(delta.sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[delta.sessionId];
          return next;
        });
      }
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  const all = useMemo(() => {
    // Stable order: sort by when each session was first created, oldest
    // first. This way typing a message in one tile (which updates lastTs)
    // doesn't reshuffle the grid — existing tiles stay put and new
    // sessions always append at the end. Fall back to id for sessions
    // missing firstTs so the sort stays deterministic.
    return Object.values(sessions).sort((a, b) => {
      const af = a.firstTs ?? "";
      const bf = b.firstTs ?? "";
      if (af !== bf) return af < bf ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }, [sessions]);

  // Only show hub-owned tiles — sessions the user explicitly spawned via
  // the + claude / + claude2 buttons. Claude sessions running in external
  // Warp terminals get auto-detected by live-detect, but the user doesn't
  // want those on the grid — they can't be driven in-page (no PTY master)
  // and just clutter the view.
  const hubTiles = useMemo(() => all.filter((s) => s.hubOwned), [all]);

  // Hidden tiles: client-side only, persisted in localStorage. Hiding never
  // touches the PTY — the session keeps running and can be unhidden any time.
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [showHiddenTray, setShowHiddenTray] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_TILES_KEY);
      if (raw) setHiddenIds(JSON.parse(raw));
    } catch {
      // localStorage unavailable — nothing hidden.
    }
  }, []);
  const persistHidden = useCallback((next: string[]) => {
    setHiddenIds(next);
    try {
      localStorage.setItem(HIDDEN_TILES_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);
  const hideTile = useCallback(
    (id: string) => persistHidden([...hiddenIds.filter((h) => h !== id), id]),
    [hiddenIds, persistHidden],
  );
  const unhideTile = useCallback(
    (id: string) => persistHidden(hiddenIds.filter((h) => h !== id)),
    [hiddenIds, persistHidden],
  );

  const visible = useMemo(
    () => hubTiles.filter((s) => !hiddenIds.includes(s.id)),
    [hubTiles, hiddenIds],
  );
  const hiddenTiles = useMemo(
    () => hubTiles.filter((s) => hiddenIds.includes(s.id)),
    [hubTiles, hiddenIds],
  );
  // A hidden tile that needs attention still deserves a visual cue.
  const hiddenNeedsYou = hiddenTiles.some(
    (s) => s.isLive && (s.needsAttention || s.waitingForInput),
  );

  return (
    <main className="relative mx-auto w-full max-w-[1760px] px-7 pb-16 pt-7">
      {/* Minimal masthead: new session button + hidden tray. */}
      <header className="mb-6 flex items-center justify-end gap-4">
        <div className="relative flex items-center gap-3 text-[11px]">
          {hiddenTiles.length > 0 && (
            <button
              type="button"
              onClick={() => setShowHiddenTray((v) => !v)}
              className={`flex items-center gap-2 rounded-full border px-4 py-1.5 font-medium ${
                hiddenNeedsYou
                  ? "border-term-amber/70 bg-term-amber/15 text-term-amber"
                  : "border-edge bg-bg-panel text-ink-muted hover:text-ink"
              }`}
            >
              hidden ({hiddenTiles.length})
            </button>
          )}
          {showHiddenTray && hiddenTiles.length > 0 && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[300px] rounded-xl border border-edge bg-bg-panel p-2 shadow-tile">
              {hiddenTiles.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-bg-header"
                >
                  <span className="truncate text-ink" title={s.cwd}>
                    {tileName(s)}
                    {s.isLive && s.needsAttention && (
                      <span className="ml-2 text-[#ff8a85]">needs you</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      unhideTile(s.id);
                      if (hiddenTiles.length <= 1) setShowHiddenTray(false);
                    }}
                    className="shrink-0 rounded-full border border-term-violet/60 bg-term-violet/10 px-3 py-0.5 text-term-violet hover:bg-term-violet/20"
                  >
                    show
                  </button>
                </div>
              ))}
            </div>
          )}
          <a
            href="/live/new?flavor=claude"
            className="flex items-center gap-2 rounded-full border border-term-violet/60 bg-term-violet/10 px-4 py-1.5 font-medium text-term-violet hover:bg-term-violet/20"
          >
            <span className="text-[14px] leading-none">+</span>
            claude
          </a>
        </div>
      </header>

      {/* ── Grid ────────────────────────────────────────────────── */}
      {hubTiles.length === 0 ? (
        <div className="flex h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-edge text-[13px] text-ink-muted">
          <div>No active sessions.</div>
          <div className="flex items-center gap-3">
            <a
              href="/live/new?flavor=claude"
              className="rounded-full border border-term-violet/60 bg-term-violet/10 px-4 py-1.5 font-medium text-term-violet hover:bg-term-violet/20"
            >
              + claude
            </a>
            <a
              href="/live/new?flavor=claude2"
              className="rounded-full border border-term-cyan/60 bg-term-cyan/10 px-4 py-1.5 font-medium text-term-cyan hover:bg-term-cyan/20"
            >
              + claude2
            </a>
          </div>
        </div>
      ) : (
        <div className="fade-stagger grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((s, i) => (
            <div
              key={s.id}
              style={{ animationDelay: `${Math.min(i * 60, 600)}ms` }}
            >
              <TerminalTile
                session={s}
                recent={recent[s.id] ?? s.recent ?? []}
                onHide={() => hideTile(s.id)}
              />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "cyan" | "violet";
}) {
  const accentCls =
    accent === "green"
      ? "text-term-green"
      : accent === "cyan"
        ? "text-term-cyan"
        : accent === "violet"
          ? "text-term-violet"
          : "text-ink";
  return (
    <div className="noise relative rounded-xl border border-edge bg-bg-panel/70 px-4 py-3">
      <div className="text-[9.5px] uppercase tracking-[0.22em] text-ink-faint">
        {label}
      </div>
      <div className={`mt-1 text-[22px] font-semibold leading-none ${accentCls}`}>
        {value}
      </div>
      {sub && (
        <div className="mt-1.5 truncate text-[10.5px] text-ink-muted">
          {sub}
        </div>
      )}
    </div>
  );
}

// FilterPill kept for future use but no longer referenced after filter removal.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _FilterPill({
  active,
  onClick,
  children,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: "green";
}) {
  const base = "rounded-full border px-3 py-1 text-[10.5px] uppercase tracking-wider transition";
  if (active) {
    const ring =
      accent === "green"
        ? "border-term-green/60 bg-term-green/10 text-term-green"
        : "border-term-violet/60 bg-term-violet/12 text-term-violet";
    return (
      <button className={`${base} ${ring}`} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <button
      className={`${base} border-edge bg-transparent text-ink-muted hover:border-edge-hi hover:text-ink`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
