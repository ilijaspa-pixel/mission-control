"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { SessionSnapshot, TimelineEvent } from "@/lib/types";
import { EventStream } from "./EventStream";

const AUTO_SCROLL_ON_NEW = true; // always follow new events, no toggle

function formatContext(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

function shortCwd(cwd: string): string {
  const home = "/Users/";
  if (!cwd.startsWith(home)) return cwd;
  const parts = cwd.slice(home.length).split("/");
  if (parts.length <= 1) return `~`;
  return "~/" + parts.slice(1).join("/");
}

export function SessionDetailClient({
  initialSnapshot,
  initialEvents,
}: {
  initialSnapshot: SessionSnapshot;
  initialEvents: TimelineEvent[];
}) {
  const [snap, setSnap] = useState<SessionSnapshot>(initialSnapshot);
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live updates
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("delta", (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        if (d.kind === "events" && d.sessionId === initialSnapshot.id) {
          setSnap(d.snapshot);
          setEvents((prev) => [...prev, ...d.events]);
        } else if (d.kind === "liveness" && d.sessionId === initialSnapshot.id) {
          setSnap((s) => ({ ...s, isLive: d.isLive }));
        }
      } catch {
        // ignore
      }
    });
    return () => es.close();
  }, [initialSnapshot.id]);

  // Auto-scroll on new events. No toggle, no button — it just follows.
  useEffect(() => {
    if (!AUTO_SCROLL_ON_NEW) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  // Thinking blocks are always hidden in the read-only preview. If you need
  // them you can grep the JSONL directly.
  const visibleEvents = events.filter((e) => e.kind !== "assistant_thinking");

  return (
    <main className="mx-auto flex h-screen w-full max-w-[1380px] flex-col px-6 py-6">
      {/* Top bar: back link + close */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[10.5px] uppercase tracking-[0.22em] text-ink-muted hover:text-term-violet"
        >
          ← back to mission control
        </Link>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-term-red/60 bg-term-red/10 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-term-red hover:bg-term-red/20"
        >
          <span className="text-[13px] leading-none">×</span>
          close
        </Link>
      </div>

      <div className="noise relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[16px] bg-bg-terminal shadow-tile">
        {/* ── Warp header ───────────────────────────────────── */}
        <div className="relative flex h-[40px] shrink-0 items-center gap-3 border-b border-edge/70 bg-bg-header px-4">
          <div className="flex items-center gap-[7px]">
            <span className="h-[12px] w-[12px] rounded-full bg-[#ff5f57] ring-1 ring-black/40" />
            <span className="h-[12px] w-[12px] rounded-full bg-[#febc2e] ring-1 ring-black/40" />
            <span className="h-[12px] w-[12px] rounded-full bg-[#28c840] ring-1 ring-black/40" />
          </div>

          <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center">
            <div className="flex max-w-[65%] items-center gap-2 text-[12.5px]">
              {snap.ccVersion && (
                <span className="text-ink-faint">v{snap.ccVersion}</span>
              )}
              <span className="truncate text-ink-dim">
                {shortCwd(snap.cwd) || "—"}
              </span>
              {snap.gitBranch && (
                <>
                  <span className="text-ink-faint">git:(</span>
                  <span className="truncate text-term-git">
                    {snap.gitBranch}
                  </span>
                  <span className="text-ink-faint">)</span>
                </>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="rounded border border-edge bg-bg-panel/80 px-1.5 py-[2px] text-[9.5px] uppercase tracking-wider text-ink-muted">
              {snap.projectLabel}
            </span>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5"
        >
          {snap.firstUserMessage && (
            <div className="mb-4 rounded-md border border-edge/70 bg-bg-panel/50 px-3 py-2 text-[11px] text-ink-muted">
              <span className="text-[9.5px] uppercase tracking-[0.22em] text-ink-faint">
                original prompt
              </span>
              <div className="mt-1 text-ink-dim">{snap.firstUserMessage}</div>
            </div>
          )}
          <EventStream events={visibleEvents} />
          {snap.isLive && <span className="caret mt-1" aria-hidden />}
        </div>

        {/* ── Status footer ─────────────────────────────── */}
        <div className="shrink-0 border-t border-edge/70 bg-bg-header/95">
          <div className="flex items-center gap-4 px-4 pt-2 text-[12px]">
            <span className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${snap.isLive ? "animate-pulse-soft bg-term-green" : "bg-ink-faint"}`}
              />
              <span className="font-medium text-ink">{snap.modelDisplay}</span>
              <span className="text-ink-faint">(1M context)</span>
            </span>
            <span className="text-ink-muted">
              {formatContext(snap.contextTokens)} ctx
            </span>
            <span className="text-ink-muted">
              in {formatContext(snap.totalInputTokens)} · out{" "}
              {formatContext(snap.totalOutputTokens)} · cache{" "}
              {formatContext(snap.totalCacheReadTokens)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <div className="h-1.5 w-[160px] overflow-hidden rounded-full bg-bg-hover ring-1 ring-edge">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-term-green via-term-cyan to-term-violet"
                  style={{
                    width: `${Math.min(100, (snap.contextTokens / 1_000_000) * 100)}%`,
                  }}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 px-4 pb-3 pt-1 text-[10px]">
            <span className="uppercase tracking-wider text-term-amber">
              ⏵⏵ {snap.permissionMode ?? "default"} permissions
            </span>
            <span className="text-ink-faint">shift+tab to cycle</span>
            <span className="ml-auto text-ink-faint">
              {snap.eventCount} events · session {snap.id.slice(0, 8)}
            </span>
          </div>
        </div>
      </div>

      {/* resume hint */}
      <div className="mt-3 text-center text-[10px] uppercase tracking-[0.22em] text-ink-faint">
        to continue this session in a terminal →{" "}
        <code className="rounded bg-bg-panel px-2 py-[2px] text-term-violet">
          claude -r {snap.id}
        </code>
      </div>
    </main>
  );
}
