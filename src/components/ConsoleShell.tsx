"use client";

// App shell (ChatGPT / Grok style): left sidebar listing every hub-owned
// console, ONE console open on the right in the Grok chat view. Owns the
// single /api/stream SSE connection and the "done"/"needs you" chime that
// HubClient plays on the old grid (/grid).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot, TimelineEvent } from "@/lib/types";
import {
  SIDEBAR_KEY,
  fallbackName,
  flavorOf,
  readHidden,
  readLabel,
  statusOf,
  writeHidden,
  writeLabel,
  type ConsoleStatus,
} from "@/lib/console-meta";
import { LiveSessionClient } from "./LiveSessionClient";
import { Icon } from "./GrokChat";
import s from "./GrokChat.module.css";

type Delta =
  | { kind: "snapshot"; session: SessionSnapshot }
  | { kind: "events"; sessionId: string; events: TimelineEvent[]; snapshot: SessionSnapshot }
  | { kind: "liveness"; sessionId: string; isLive: boolean }
  | { kind: "evict"; sessionId: string };

type Flavor = "claude" | "claude2";
type Selected = { id: string; mode: "new" | "resume"; flavor: Flavor; nonce: number };

const EVENT_CAP = 3000;
const evKey = (e: TimelineEvent) => `${e.uuid}|${e.kind}|${e.toolUseId ?? ""}`;

function mergeList(prev: TimelineEvent[] | undefined, add: TimelineEvent[]): TimelineEvent[] {
  if (!prev || prev.length === 0) return add.slice(-EVENT_CAP);
  if (!add.length) return prev;
  const seen = new Set(prev.map(evKey));
  const fresh = add.filter((e) => !seen.has(evKey(e)));
  if (!fresh.length) return prev;
  return [...prev, ...fresh].slice(-EVENT_CAP);
}

function parseLocation(): { id: string; flavor: Flavor } | null {
  const m = window.location.pathname.match(/^\/live\/([^/?#]+)/);
  if (!m) return null;
  const f = new URLSearchParams(window.location.search).get("flavor");
  return { id: decodeURIComponent(m[1]), flavor: f === "claude2" ? "claude2" : "claude" };
}

export function ConsoleShell({
  initialSessions,
  initialRecent,
  initialSelected,
}: {
  initialSessions: SessionSnapshot[];
  initialRecent: Record<string, TimelineEvent[]>;
  initialSelected: { id: string; mode: "new" | "resume"; flavor: Flavor } | null;
}) {
  const [sessions, setSessions] = useState<Record<string, SessionSnapshot>>(() => {
    const m: Record<string, SessionSnapshot> = {};
    for (const x of initialSessions) m[x.id] = x;
    return m;
  });
  const [recent, setRecent] = useState<Record<string, TimelineEvent[]>>(initialRecent);
  const [selected, setSelected] = useState<Selected | null>(
    initialSelected ? { ...initialSelected, nonce: 0 } : null,
  );
  // Real id of a console started with "+" (InteractiveTerminal rewrites the
  // URL to /live/<id> once the server reports it).
  const [resolvedNewId, setResolvedNewId] = useState<string | null>(null);

  // ── Chime + tab-title counter (same as HubClient) ─────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);
  const pendingDingsRef = useRef(0);
  const baseTitleRef = useRef("");
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
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
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
    } catch {}
  }, []);
  const bumpTabTitle = useCallback(() => {
    if (!document.hidden) return;
    pendingDingsRef.current += 1;
    document.title = `(${pendingDingsRef.current}) ${baseTitleRef.current}`;
  }, []);
  const checkTransition = useCallback(
    (was: SessionSnapshot | undefined, next: SessionSnapshot) => {
      if (!was || !next.hubOwned || !next.isLive) return;
      if ((next.waitingForInput && !was.waitingForInput) || (next.needsAttention && !was.needsAttention)) {
        playDing();
        bumpTabTitle();
      }
    },
    [playDing, bumpTabTitle],
  );

  // ── SSE ───────────────────────────────────────────────────────────
  // EventSource retries a dropped connection by itself, but gives up for good if the server
  // ever answers non-200 (a dev compile error): the chat then froze silently. Reconnect with
  // backoff when that happens; the "ready" payload re-syncs everything.
  const [sseGen, setSseGen] = useState(0);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    let retry: ReturnType<typeof setTimeout> | null = null;
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && !retry) {
        retry = setTimeout(() => setSseGen((n) => n + 1), Math.min(30_000, 2_000 * 2 ** Math.min(sseGen, 4)));
      }
    };
    es.addEventListener("open", () => {
      if (sseGen) setSseGen(0);
    });
    es.addEventListener("ready", (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) as {
          sessions?: SessionSnapshot[];
          recent?: Record<string, TimelineEvent[]>;
        };
        if (Array.isArray(p.sessions)) {
          const m: Record<string, SessionSnapshot> = {};
          for (const x of p.sessions) m[x.id] = x;
          setSessions(m);
        }
        if (p.recent) {
          setRecent((prev) => {
            const next: Record<string, TimelineEvent[]> = { ...prev };
            for (const [id, list] of Object.entries(p.recent!)) next[id] = mergeList(prev[id], list);
            return next;
          });
        }
      } catch {}
    });
    es.addEventListener("delta", (e: MessageEvent) => {
      let d: Delta;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      if (d.kind === "events") {
        setSessions((prev) => {
          checkTransition(prev[d.sessionId], d.snapshot);
          return { ...prev, [d.sessionId]: d.snapshot };
        });
        if (d.events?.length) {
          setRecent((prev) => ({ ...prev, [d.sessionId]: mergeList(prev[d.sessionId], d.events) }));
        }
      } else if (d.kind === "snapshot") {
        setSessions((prev) => {
          checkTransition(prev[d.session.id], d.session);
          return { ...prev, [d.session.id]: d.session };
        });
      } else if (d.kind === "liveness") {
        setSessions((prev) => {
          const x = prev[d.sessionId];
          return x ? { ...prev, [d.sessionId]: { ...x, isLive: d.isLive } } : prev;
        });
      } else if (d.kind === "evict") {
        setSessions((prev) => {
          if (!(d.sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[d.sessionId];
          return next;
        });
      }
    });
    return () => {
      if (retry) clearTimeout(retry);
      es.close();
    };
  }, [checkTransition, sseGen]);

  // ── Labels + hidden (shared with the grid via localStorage) ───────
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const sessionIdsKey = Object.keys(sessions).sort().join(",");
  useEffect(() => {
    const m: Record<string, string> = {};
    for (const id of sessionIdsKey.split(",")) if (id) m[id] = readLabel(id);
    setLabels(m);
  }, [sessionIdsKey]);
  useEffect(() => {
    setHidden(readHidden());
    setHydrated(true);
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === "mc-hidden-tiles") setHidden(readHidden());
      else if (e.key.startsWith("tile-label:")) {
        const id = e.key.slice("tile-label:".length);
        setLabels((prev) => ({ ...prev, [id]: e.newValue ?? "" }));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const rename = (id: string, name: string) => {
    writeLabel(id, name);
    setLabels((prev) => ({ ...prev, [id]: name.trim() }));
  };
  const setHiddenPersist = (next: string[]) => {
    setHidden(next);
    writeHidden(next);
  };

  // ── Stable order: most recent activity at load; new consoles on top ──
  const orderRef = useRef<string[]>([]);
  const consoles = useMemo(() => {
    const owned = Object.values(sessions).filter(
      (x) => x.hubOwned || x.id === selected?.id || x.id === resolvedNewId,
    );
    const known = new Set(orderRef.current);
    const fresh = owned
      .filter((x) => !known.has(x.id))
      .sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
      .map((x) => x.id);
    orderRef.current = orderRef.current.length === 0 ? fresh : [...fresh, ...orderRef.current];
    const byId = new Map(owned.map((x) => [x.id, x]));
    return orderRef.current.map((id) => byId.get(id)).filter((x): x is SessionSnapshot => !!x);
  }, [sessions, selected?.id, resolvedNewId]);

  const visible = consoles.filter((x) => !hidden.includes(x.id));
  const hiddenList = consoles.filter((x) => hidden.includes(x.id));

  // ── Selection / URL ───────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "collapsed");
    } catch {}
  }, []);
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setDrawerOpen((v) => !v);
      return;
    }
    setCollapsed((v) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, v ? "open" : "collapsed");
      } catch {}
      return !v;
    });
  };

  const select = useCallback((id: string, flavor: Flavor) => {
    setSelected((cur) => (cur && cur.id === id ? cur : { id, mode: "resume", flavor, nonce: Date.now() }));
    setResolvedNewId(null);
    setDrawerOpen(false);
    const url = `/live/${id}?flavor=${flavor}`;
    if (window.location.pathname + window.location.search !== url) window.history.pushState(null, "", url);
  }, []);

  const startNew = (flavor: Flavor) => {
    setSelected({ id: "new", mode: "new", flavor, nonce: Date.now() });
    setResolvedNewId(null);
    setDrawerOpen(false);
    window.history.pushState(null, "", `/live/new?flavor=${flavor}`);
  };

  // Back/forward between consoles.
  useEffect(() => {
    const onPop = () => {
      const loc = parseLocation();
      if (!loc) return;
      if (loc.id === "new") return;
      setSelected((cur) => (cur && (cur.id === loc.id || resolvedNewId === loc.id) ? cur : { id: loc.id, mode: "resume", flavor: loc.flavor, nonce: Date.now() }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [resolvedNewId]);

  // A "+" console: watch for the terminal rewriting the URL to the real id.
  useEffect(() => {
    if (selected?.id !== "new" || resolvedNewId) return;
    const t = setInterval(() => {
      const loc = parseLocation();
      if (loc && loc.id !== "new") {
        setResolvedNewId(loc.id);
        try {
          window.history.replaceState(null, "", `/live/${loc.id}?flavor=${selected.flavor}`);
        } catch {}
      }
    }, 800);
    return () => clearInterval(t);
  }, [selected, resolvedNewId]);

  // If the shell opened on "/" with a hidden console preselected, prefer a visible one.
  const fixedDefault = useRef(false);
  useEffect(() => {
    if (!hydrated || fixedDefault.current) return;
    fixedDefault.current = true;
    if (!selected || selected.mode === "new") return;
    if (window.location.pathname !== "/") return;
    if (hidden.includes(selected.id) && visible[0]) {
      setSelected({ id: visible[0].id, mode: "resume", flavor: flavorOf(visible[0]), nonce: Date.now() });
    }
  }, [hydrated, hidden, selected, visible]);

  const activeId = selected ? (selected.id === "new" ? resolvedNewId : selected.id) : null;
  const activeSnap = activeId ? sessions[activeId] ?? null : null;

  const onEnded = () => {
    const next = visible.find((x) => x.id !== activeId);
    if (next) select(next.id, flavorOf(next));
    else {
      setSelected(null);
      window.history.pushState(null, "", "/");
    }
  };

  const [hiddenOpen, setHiddenOpen] = useState(false);
  const hiddenNeedsYou = hiddenList.some((x) => statusOf(x) === "needs");

  const sidebar = (
    <nav className={`${s.root} flex h-full w-[260px] shrink-0 flex-col border-r border-[#1A1A1A] bg-[#0A0A0A]`}>
      <div className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-[13px] font-medium text-[#8A8A8A]">Consoles</span>
        {/* One click = new claude console (claude2 no longer offered). */}
        <button type="button" title="New console" onClick={() => startNew("claude")} className={s.iconBtn}>
          <Icon d="M12 5v14M5 12h14" />
        </button>
      </div>

      <div className={`${s.scroll} min-h-0 flex-1 overflow-y-auto px-2 pb-2`}>
        {selected?.id === "new" && !resolvedNewId && (
          <Row name="New console" status="working" selected onSelect={() => {}} />
        )}
        {visible.map((x) => (
          <Row
            key={x.id}
            name={labels[x.id] || fallbackName(x)}
            title={x.cwd}
            status={statusOf(x)}
            selected={x.id === activeId}
            onSelect={() => select(x.id, flavorOf(x))}
            onRename={(n) => rename(x.id, n)}
            onHide={() => setHiddenPersist([...hidden.filter((h) => h !== x.id), x.id])}
          />
        ))}
        {hydrated && visible.length === 0 && !(selected?.id === "new") && (
          <div className="px-2.5 py-2 text-[13px] text-[#5f5f5f]">No consoles running</div>
        )}
      </div>

      {hiddenList.length > 0 && (
        <div className="shrink-0 border-t border-[#161616] px-2 py-2">
          <button
            type="button"
            onClick={() => setHiddenOpen((v) => !v)}
            className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-[13px] text-[#8A8A8A] hover:bg-[#161616] hover:text-[#D4D4D4]"
          >
            <span className={`transition-transform ${hiddenOpen ? "rotate-90" : ""}`}>
              <Icon size={13} d="M9 6l6 6-6 6" />
            </span>
            Hidden ({hiddenList.length})
            {hiddenNeedsYou && <span className="ml-auto h-2 w-2 animate-pulse rounded-full bg-[#ff5f57]" />}
          </button>
          {hiddenOpen && (
            <div className="mt-1 max-h-[40vh] overflow-y-auto">
              {hiddenList.map((x) => (
                <Row
                  key={x.id}
                  name={labels[x.id] || fallbackName(x)}
                  title={x.cwd}
                  status={statusOf(x)}
                  selected={x.id === activeId}
                  dim
                  onSelect={() => select(x.id, flavorOf(x))}
                  onRename={(n) => rename(x.id, n)}
                  onUnhide={() => setHiddenPersist(hidden.filter((h) => h !== x.id))}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="shrink-0 px-2 pb-3">
        <a
          href="/grid"
          className="flex h-8 items-center gap-2 rounded-[8px] px-2.5 text-[13px] text-[#737373] hover:bg-[#161616] hover:text-[#D4D4D4]"
        >
          <Icon size={15}>
            <rect x="4" y="4" width="7" height="7" rx="1.5" />
            <rect x="13" y="4" width="7" height="7" rx="1.5" />
            <rect x="4" y="13" width="7" height="7" rx="1.5" />
            <rect x="13" y="13" width="7" height="7" rx="1.5" />
          </Icon>
          Grid view
        </a>
      </div>
    </nav>
  );

  return (
    <main className="flex h-[100dvh] w-full overflow-hidden bg-black">
      {/* Desktop sidebar */}
      {!collapsed && <div className="hidden h-full md:flex">{sidebar}</div>}
      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          {sidebar}
          <div className="flex-1 bg-black/60" onClick={() => setDrawerOpen(false)} />
        </div>
      )}

      <div className="flex h-full min-w-0 flex-1 flex-col">
        {selected ? (
          <LiveSessionClient
            key={`${selected.id}:${selected.nonce}`}
            sessionId={selected.id}
            mode={selected.mode}
            flavor={selected.flavor}
            snapshot={activeSnap}
            events={(activeId && recent[activeId]) || []}
            onToggleSidebar={toggleSidebar}
            onEnded={onEnded}
          />
        ) : (
          <div className={`${s.root} flex h-full flex-col`}>
            <div className="flex h-14 items-center px-3">
              <button type="button" title="Consoles" onClick={toggleSidebar} className={s.iconBtn}>
                <span className="md:hidden"><Icon d="M4 7h16M4 12h16M4 17h10" /></span>
                <span className="hidden md:block"><Icon>
                  <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
                  <path d="M9.5 4.5v15" />
                </Icon></span>
              </button>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-24 text-center">
              <div className="text-[26px] font-medium tracking-[-0.02em] text-[#ECECEC]">
                Pick a console or start a new one
              </div>
              <button
                type="button"
                onClick={() => startNew("claude")}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-5 text-[14px] font-medium text-black hover:bg-[#d9d9d9]"
              >
                <Icon size={16} d="M12 5v14M5 12h14" />
                New console
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// ── Sidebar row ─────────────────────────────────────────────────────────
const DOT: Record<ConsoleStatus, { cls: string; label: string }> = {
  needs: { cls: "bg-[#ff5f57] animate-pulse shadow-[0_0_0_3px_rgba(255,95,87,0.18)]", label: "Needs you" },
  // Green = Claude is done and it's your turn. Working = a small grey spinner,
  // so "still busy" never looks like "finished" (owner read green as done).
  waiting: { cls: "bg-[#4ADE80]", label: "Done, your turn" },
  working: { cls: "!h-[10px] !w-[10px] bg-transparent border-[1.5px] border-[#3F3F3F] border-t-[#E5E5E5] animate-spin", label: "Working" },
  idle: { cls: "bg-[#3a3a3a]", label: "Idle" },
};

function Row({
  name,
  title,
  status,
  selected,
  dim,
  onSelect,
  onRename,
  onHide,
  onUnhide,
}: {
  name: string;
  title?: string;
  status: ConsoleStatus;
  selected: boolean;
  dim?: boolean;
  onSelect: () => void;
  onRename?: (name: string) => void;
  onHide?: () => void;
  onUnhide?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const dot = DOT[status];
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== name.trim()) onRename?.(draft);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      onClick={() => !editing && onSelect()}
      onDoubleClick={() => {
        if (!onRename) return;
        setDraft(name);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (!editing && e.key === "Enter") onSelect();
      }}
      className={`group my-[1px] flex h-8 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 text-[14px] outline-none transition-colors ${
        selected ? "bg-[#1F1F1F] text-white" : `${dim ? "text-[#8A8A8A]" : "text-[#D4D4D4]"} hover:bg-[#161616]`
      } ${status === "needs" && !selected ? "text-white" : ""}`}
    >
      <span className={`h-[9px] w-[9px] shrink-0 rounded-[2.5px] border ${selected ? "border-[#bdbdbd]" : "border-[#5a5a5a]"}`} />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1 rounded-[5px] border border-[#3a3a3a] bg-black px-1.5 py-[1px] text-[14px] text-white outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{name}</span>
      )}
      {!editing && (onHide || onUnhide) && (
        <button
          type="button"
          title={onHide ? "Hide (keeps running)" : "Show in list"}
          onClick={(e) => {
            e.stopPropagation();
            (onHide ?? onUnhide)?.();
          }}
          className="hidden h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[#8A8A8A] hover:bg-[#262626] hover:text-white group-hover:grid"
        >
          {onHide ? (
            <Icon size={14}>
              <path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.6 3.8M6.6 6.6C4.4 8 3 10.2 2.5 12c1 2.5 4.5 7 9.5 7 1.8 0 3.4-.6 4.8-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </Icon>
          ) : (
            <Icon size={14}>
              <path d="M2.5 12C3.5 9.5 7 5 12 5s8.5 4.5 9.5 7c-1 2.5-4.5 7-9.5 7s-8.5-4.5-9.5-7z" />
              <circle cx="12" cy="12" r="3" />
            </Icon>
          )}
        </button>
      )}
      <span title={dot.label} className={`h-2 w-2 shrink-0 rounded-full ${dot.cls}`} />
    </div>
  );
}
