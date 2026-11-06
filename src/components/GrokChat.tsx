"use client";

// Grok-style (grok.com dark mode) chat view of a live Claude Code session,
// used as the default view on /live/[id]. Read side mirrors
// SessionDetailClient (initial events from the server + /api/stream SSE
// deltas); write side mirrors the hub tile QuickInputBar (POST
// /api/pty-input with text + "\r"). Hub tiles keep using EventStream.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { SessionSnapshot, TimelineEvent } from "@/lib/types";
import { isBlocked } from "@/lib/console-meta";
import s from "./GrokChat.module.css";

const MAX_RENDERED = 400; // events rendered at once; "show earlier" adds more

const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <pre>{children}</pre>,
  // Screenshots Claude saved on this Mac come through as absolute file paths;
  // load them via the local-image route instead of showing a broken icon.
  img: ({ src, alt }) => {
    const s = typeof src === "string" ? src : "";
    const url = s.startsWith("/") ? `/api/local-image?path=${encodeURIComponent(s)}` : s;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={alt ?? ""} className="my-2 max-h-[520px] max-w-full rounded-[12px] border border-[#262626]" />;
  },
};

type ToolInputShape = Record<string, unknown> | undefined;

function summarizeToolInput(name: string, input: ToolInputShape): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return String(o.command ?? "").replace(/\s+/g, " ").slice(0, 200);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return String(o.file_path ?? o.path ?? o.notebook_path ?? "").split("/").slice(-3).join("/");
    case "Glob":
      return String(o.pattern ?? "");
    case "Grep":
      return `${String(o.pattern ?? "")}${o.glob ? `  ${o.glob}` : ""}${o.path ? `  ${o.path}` : ""}`;
    case "Task":
    case "Agent":
      return String(o.description ?? o.subagent_type ?? "");
    case "WebFetch":
      return String(o.url ?? "");
    case "WebSearch":
      return String(o.query ?? "");
    case "TodoWrite":
      return Array.isArray(o.todos) ? `${(o.todos as unknown[]).length} todos` : "";
    case "TaskCreate":
      return String(o.subject ?? "");
    case "TaskUpdate":
      return `${o.taskId ?? ""} → ${o.status ?? ""}`;
    default: {
      const pairs: string[] = [];
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && v.length < 80) pairs.push(`${k}=${v}`);
        if (pairs.length >= 2) break;
      }
      return pairs.join("  ");
    }
  }
}

function cleanText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-(?:name|args|message)>[\s\S]*?<\/command-[^>]+>/g, "")
    .replace(/<local-command-(?:stdout|stderr|caveat)>[\s\S]*?<\/local-command-[^>]+>/g, "")
    // Pasted text is saved wrapped in <pasted_content id="…">…</pasted_content>: show what was pasted.
    .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content>/g, "$1")
    .trim();
}

// For matching an optimistic bubble to the saved message: spacing and line breaks can differ.
// Matching the optimistic bubble to the user turn that actually landed. The two are rarely
// byte-identical: a paste comes back wrapped in <pasted_content id="…">…</pasted_content>, and the
// harness can append screenshot notes to the same turn. Strip the wrapper, then accept containment
// either way, so the echo is dropped instead of sitting next to the real message as a duplicate
// (2026-11-03). Containment needs some length behind it, or a short "ok" would match any older turn
// that happens to contain it and vanish before the real one arrives.
const PASTED_TAGS = /<\/?pasted_content[^>]*>/g;
const normText = (s: string) => s.replace(PASTED_TAGS, " ").replace(/\s+/g, " ").trim().replace(/^!\s*/, "! ");
const sameText = (a: string, b: string) => {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return y.length >= 12 && (x.includes(y) || y.includes(x));
};

// Text the harness injects into the transcript as a "user" turn (image notes
// after a tool read a screenshot, reminders, task notifications, slash-command
// echoes). The owner never typed these, so they must not show as his bubbles.
const AUTO_USER_PREFIXES = [
  "Caveat: The messages below were generated",
  "[Image: original",
  "[Image:",
  "<system-reminder>",
  "<task-notification>",
  "<local-command",
  "<command-",
  "[Request interrupted",
  "This session is being continued",
  "Tool loaded.",
  // Skill instructions Claude Code loads into the transcript as a "user" turn (2026-11-03).
  "Base directory for this skill:",
  "(Re-invocation of /",
  "Launching skill",
];

// A "!" shell command lands as <bash-input>cmd</bash-input>, then its output as a separate
// <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr> turn. Show them as ONE bubble:
// "! cmd" with the output underneath (2026-11-03; it used to be three bubbles).
const BASH_IN = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/;
const BASH_OUT = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/;

function cleanUserText(text: string): string {
  // Strip reminder blocks the harness appends inside real messages.
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim()
    .replace(BASH_IN, (_m, cmd: string) => `! ${cmd.trim()}`);
  const t = cleanText(stripped);
  if (AUTO_USER_PREFIXES.some((p) => t.startsWith(p))) return "";
  return t;
}

// ── Turn grouping ────────────────────────────────────────────────────────
type ToolCall = { use: TimelineEvent; result?: TimelineEvent };
type Block =
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; call: ToolCall };
type Turn =
  | { kind: "user"; key: string; text: string; shots: string[]; pending?: boolean; output?: string }
  | { kind: "assistant"; key: string; blocks: Block[] };

const SHOT_RE = /\[screenshot image:\s*"([^"]+)"\]/g;

function buildTurns(events: TimelineEvent[]): Turn[] {
  const results = new Map<string, TimelineEvent>();
  for (const ev of events) {
    if (ev.kind === "tool_result" && ev.toolUseId) results.set(ev.toolUseId, ev);
  }
  const autoBases = new Set(events.filter((e) => e.kind === "tool_result" && e.uuid).map((e) => e.uuid!.split(":")[0]!));
  const turns: Turn[] = [];
  let cur: Extract<Turn, { kind: "assistant" }> | null = null;
  // Keys must not depend on the event's position: the list is a sliding window
  // (last N events), so position-based keys changed on EVERY new event and React
  // remounted every message, screenshots included, which flashed the page up and
  // back (2026-11-03). uuid + its occurrence count is stable as the window slides.
  const seenKey = new Map<string, number>();
  events.forEach((ev) => {
    const base = ev.uuid ?? `${ev.kind}@${ev.ts ?? ""}`;
    const n = seenKey.get(base) ?? 0;
    seenKey.set(base, n + 1);
    const key = `${base}#${n}`;
    if (ev.kind === "user") {
      // A text block riding in the same message as a tool_result is an
      // auto-generated note (e.g. the image size line), not something typed.
      if (ev.uuid?.includes(":u") && autoBases.has(ev.uuid.split(":")[0]!)) return;
      const out = (ev.text ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").match(BASH_OUT);
      if (out) {
        const output = [out[1], out[2]].map((x) => (x ?? "").trim()).filter(Boolean).join("\n");
        const prev = turns[turns.length - 1];
        if (prev?.kind === "user" && prev.text.startsWith("! ")) prev.output = output;
        else if (output) turns.push({ kind: "user", key, text: "", shots: [], output });
        cur = null;
        return;
      }
      const raw = cleanUserText(ev.text ?? "");
      if (!raw) return;
      const shots = [...raw.matchAll(SHOT_RE)].map((m) => m[1]);
      const text = raw.replace(SHOT_RE, "").trim();
      cur = null;
      turns.push({ kind: "user", key, text, shots });
      return;
    }
    if (ev.kind === "assistant_text" || ev.kind === "tool_use") {
      if (!cur) {
        cur = { kind: "assistant", key, blocks: [] };
        turns.push(cur);
      }
      if (ev.kind === "assistant_text") {
        const text = cleanText(ev.text ?? "");
        if (text) cur.blocks.push({ kind: "text", key, text });
      } else {
        cur.blocks.push({
          kind: "tool",
          key,
          call: { use: ev, result: ev.toolUseId ? results.get(ev.toolUseId) : undefined },
        });
      }
    }
  });
  return turns.filter((t) => t.kind === "user" || t.blocks.length > 0);
}

// ── Icons (18px, stroke 1.75) ───────────────────────────────────────────
export function Icon({ d, size = 18, children }: { d?: string; size?: number; children?: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d ? <path d={d} /> : children}
    </svg>
  );
}

const CopyIcon = () => (
  <Icon size={16}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
  </Icon>
);
const CheckIcon = () => <Icon size={16} d="M5 12.5l4.5 4.5L19 7.5" />;

// ── Pieces ──────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={done ? "Copied" : "Copy"}
      className={s.smallIcon}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch {}
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function ToolLine({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const name = call.use.toolName ?? "Tool";
  const summary = summarizeToolInput(name, call.use.toolInput as ToolInputShape);
  const out = (call.result?.toolResultPreview ?? "").trim();
  const isErr = !!call.result?.toolResultIsError;
  const canOpen = out.length > 0;
  return (
    <div className="my-[2px]">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen((v) => !v)}
        className={`${s.mono} group flex w-full min-w-0 items-baseline gap-2 rounded-md py-[3px] text-left text-[13px] leading-[1.5] text-[#8A8A8A] ${canOpen ? "cursor-pointer hover:text-[#B5B5B5]" : "cursor-default"}`}
      >
        <span className={`shrink-0 ${isErr ? "text-[#c76a6a]" : ""}`}>•</span>
        <span className="shrink-0 text-[#A3A3A3]">{name}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {canOpen && (
          <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
            <Icon size={13} d="M9 6l6 6-6 6" />
          </span>
        )}
      </button>
      {open && canOpen && (
        <pre
          className={`${s.mono} mb-2 mt-1 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-[#262626] bg-[#0B0B0B] px-3 py-2 text-[12.5px] leading-[1.5] ${isErr ? "text-[#d98b8b]" : "text-[#9A9A9A]"}`}
        >
          {out.length > 8000 ? out.slice(0, 8000) + "\n…" : out}
        </pre>
      )}
    </div>
  );
}

function UserBubble({ turn }: { turn: Extract<Turn, { kind: "user" }> }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {turn.shots.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {turn.shots.map((p, i) => (
            <ShotThumb key={i} path={p} />
          ))}
        </div>
      )}
      {turn.text && (
        <div
          className={`max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] bg-[#2A2A2A] px-4 py-2 text-[16px] leading-[1.6] text-white ${turn.pending ? "opacity-60" : ""}`}
          style={{ overflowWrap: "anywhere" }}
        >
          {turn.text.startsWith("! ") ? <span className="font-mono text-[14px]">{turn.text}</span> : turn.text}
        </div>
      )}
      {turn.output != null && turn.output !== "" && (
        <pre className="max-h-64 max-w-[85%] overflow-auto whitespace-pre-wrap break-words rounded-[14px] border border-[#2A2A2A] bg-[#111] px-3 py-2 font-mono text-[12.5px] leading-[1.5] text-[#A3A3A3]" style={{ overflowWrap: "anywhere" }}>
          {turn.output}
        </pre>
      )}
    </div>
  );
}

// A pasted screenshot as a real thumbnail (served by /api/local-image); click opens it full size.
// Falls back to the old "image" chip when the file is gone (temp pastes get cleaned up).
function ShotThumb({ path }: { path: string }) {
  const [broken, setBroken] = useState(false);
  const src = `/api/local-image?path=${encodeURIComponent(path)}`;
  if (broken) {
    return (
      <span title={path} className="inline-flex items-center gap-1.5 rounded-full border border-[#2A2A2A] bg-[#141414] px-3 py-1 text-[12.5px] text-[#A3A3A3]">
        <Icon size={13} d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        image
      </span>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" title={path} className="block overflow-hidden rounded-[14px] border border-[#2A2A2A] bg-[#141414] hover:border-[#525252]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="pasted screenshot" loading="lazy" onError={() => setBroken(true)} className="block max-h-[220px] max-w-[320px] object-contain" />
    </a>
  );
}

function AssistantTurn({ turn, showActions }: { turn: Extract<Turn, { kind: "assistant" }>; showActions: boolean }) {
  const copyText = turn.blocks
    .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n");
  // Tool steps are folded into one quiet toggle so the reply reads like a chat.
  const [showWork, setShowWork] = useState(false);
  const tools = turn.blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool");
  const texts = turn.blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text");
  return (
    <div className="flex flex-col">
      {tools.length > 0 && (
        <div className={texts.length ? "mb-3" : ""}>
          <button
            type="button"
            onClick={() => setShowWork((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[13px] text-[#737373] hover:text-[#D4D4D4]"
          >
            <span className={`inline-block transition-transform ${showWork ? "rotate-90" : ""}`}>›</span>
            {showWork ? "Hide work" : `Show work · ${tools.length} ${tools.length === 1 ? "step" : "steps"}`}
          </button>
          {showWork && (
            <div className="mt-2 flex flex-col gap-1 border-l border-[#262626] pl-3">
              {tools.map((b) => (
                <ToolLine key={b.key} call={b.call} />
              ))}
            </div>
          )}
        </div>
      )}
      {texts.map((b, i) => (
        <div key={b.key} className={`${s.md} ${i ? "mt-3" : ""}`}>
          <ReactMarkdown components={MD_COMPONENTS}>{b.text}</ReactMarkdown>
        </div>
      ))}
      {showActions && copyText && (
        <div className="-ml-[6px] mt-2 flex items-center gap-0.5">
          <CopyButton text={copyText} />
        </div>
      )}
    </div>
  );
}

// Same as the hub tile footer (TerminalTile formatContext / contextPct):
// prefer Claude Code's exact % from the statusline cache, else tokens / 1M.
const CTX_CAP = 1_000_000;
function formatContext(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
function contextPct(exact: number | null, tokens: number): number {
  if (exact != null) return Math.min(100, Math.max(0, exact));
  return Math.min(100, Math.max(0, (tokens / CTX_CAP) * 100));
}

// Background helpers Claude started and that haven't reported back yet: Agent calls that returned
// "Async agent launched … agentId: X" and Bash calls "running in background with ID: X", minus
// those whose <task-notification> (task-id X, status completed/failed/killed) has arrived.
type BgTask = { id: string; label: string; since: number };
function backgroundTasks(events: TimelineEvent[], now: number): BgTask[] {
  const labels = new Map<string, string>();
  const running = new Map<string, BgTask>();
  for (const e of events) {
    if (e.kind === "tool_use" && e.toolUseId) {
      const inp = (e.toolInput ?? {}) as { description?: string; prompt?: string; command?: string };
      labels.set(e.toolUseId, inp.description || (inp.command ?? "").slice(0, 60) || e.toolName || "Helper");
    } else if (e.kind === "tool_result" && e.toolUseId && !e.toolResultIsError) {
      const txt = e.toolResultPreview ?? "";
      const m = txt.match(/Async agent launched[\s\S]*?agentId:\s*([\w-]+)/) ?? txt.match(/running in background with ID:\s*([\w-]+)/i);
      if (m) running.set(m[1]!, { id: m[1]!, label: labels.get(e.toolUseId) ?? "Helper", since: Date.parse(e.ts) || now });
    } else if (e.kind === "user" && e.text && e.text.includes("<task-notification>")) {
      const id = e.text.match(/<task-id>([\w-]+)<\/task-id>/)?.[1];
      const st = e.text.match(/<status>(\w+)<\/status>/)?.[1];
      if (id && st && st !== "running") running.delete(id);
    }
  }
  // A helper from a session that was restarted never reports back: drop anything older than 6h.
  return [...running.values()].filter((t) => now - t.since < 6 * 3600_000);
}

const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "just started" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

function ContextLine({ snap }: { snap: SessionSnapshot }) {
  const pct = contextPct(snap.contextPct, snap.contextTokens);
  const base = snap.modelDisplay || snap.model || "Claude";
  const modelLabel = /context\)/i.test(base) ? base : `${base} (1M context)`;
  const fill = pct > 90 ? "#F87171" : pct > 70 ? "#FBBF24" : "#A3A3A3";
  return (
    <div
      className="mt-2 flex items-center gap-2 pl-[18px] text-[12px] leading-none text-[#737373]"
      title={`${Math.round(pct)}% of context used`}
    >
      <span className="truncate">
        {modelLabel} · {formatContext(snap.contextTokens)} / 1M
      </span>
      <span className="relative h-[3px] w-[72px] shrink-0 overflow-hidden rounded-full bg-[#262626]">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: fill }}
        />
      </span>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────
export function GrokChat({
  snapshot: snap,
  events,
  onOpenTerminal,
  onPendingChange,
}: {
  snapshot: SessionSnapshot;
  events: TimelineEvent[];
  onOpenTerminal: () => void;
  onPendingChange?: (hasPending: boolean) => void;
}) {
  const sessionId = snap.id;
  const [limit, setLimit] = useState(MAX_RENDERED);
  const [pending, setPending] = useState<{ id: number; text: string; at: number }[]>([]);

  useEffect(() => {
    onPendingChange?.(pending.length > 0);
  }, [pending.length, onPendingChange]);

  // Re-check on a timer too: with no new events the effect below never reran,
  // so a bubble that never "landed" kept the page saying Thinking forever.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [pending.length]);

  // Drop optimistic bubbles once the real user event lands (or after 60s).
  useEffect(() => {
    if (!pending.length) return;
    const users = events
      .filter((e) => e.kind === "user")
      .slice(-20)
      .map((e) => ({ t: e.ts ? new Date(e.ts).getTime() : 0, text: cleanUserText(e.text ?? "").replace(SHOT_RE, "").trim() }));
    const now = Date.now();
    // Only a user event that landed after this send can be its echo: an older turn with the
    // same or overlapping text used to swallow the bubble at once.
    const keep = pending.filter(
      (p) => !users.some((u) => (!u.t || u.t >= p.at - 5_000) && sameText(u.text, p.text)) && now - p.at < 60_000,
    );
    if (keep.length !== pending.length) setPending(keep);
  }, [events, pending, tick]);

  const hiddenCount = Math.max(0, events.length - limit);
  const turns = useMemo(() => buildTurns(events.slice(-limit)), [events, limit]);
  const allTurns: Turn[] = useMemo(
    () => [
      ...turns,
      ...pending.map((p) => ({ kind: "user" as const, key: `pending-${p.id}`, text: p.text, shots: [], pending: true })),
    ],
    [turns, pending],
  );

  // ── Auto-scroll unless the user scrolled up ─────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [allTurns.length, events.length, snap.needsAttention]);
  // Stay pinned whenever the content's height changes, not only when counts change:
  // at the event cap the count stays flat, and images or growing replies change
  // height with no count change at all.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el); // the box growing while typing shrinks the pane: keep the last lines visible
    return () => ro.disconnect();
  }, []);
  // "Show earlier messages" adds content above: hold the reading position instead of lurching.
  const keepFromBottom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && keepFromBottom.current != null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    }
  }, [limit]);

  // "Thinking" = Claude is mid-turn per the transcript, or you JUST sent
  // something (a few seconds of optimistic bridge). A message that never
  // lands no longer keeps it on.
  const freshPending = pending.some((p) => Date.now() - p.at < 8_000);
  // Re-render once a minute so "running · 12m" keeps counting while nothing else changes.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const bg = useMemo(() => backgroundTasks(events, Date.now()), [events]);
  const working = freshPending || (snap.isLive && !snap.waitingForInput && !snap.needsAttention);

  // How long Claude has been on this turn, like the terminal's "(3m 13s)": counts from the
  // message that started it (your last real message, or the one you just sent).
  const turnStart = useMemo(() => {
    const lastPending = pending.length ? pending[pending.length - 1]!.at : 0;
    let fromEvent = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind !== "user" || !e.ts) continue;
      if (!cleanUserText(e.text ?? "")) continue; // reminders, task notices: not a real message
      fromEvent = new Date(e.ts).getTime();
      break;
    }
    return Math.max(lastPending, fromEvent) || 0;
  }, [events, pending]);
  const [, setSecond] = useState(0);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setSecond((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [working]);
  const elapsed = (() => {
    if (!turnStart) return "";
    const secs = Math.max(0, Math.floor((Date.now() - turnStart) / 1000));
    const m = Math.floor(secs / 60);
    return m ? `${m}m ${secs % 60}s` : `${secs}s`;
  })();

  // ── Input ───────────────────────────────────────────────────────────
  // The draft survives a remount (dev hot-reload, the snapshot blinking null): a
  // remount used to reset it to "" mid-typing and the first characters were lost.
  const draftKey = `mc-draft:${sessionId}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [text, draftKey]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  }, [text]);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Several pastes can be in flight; Enter during an upload is remembered and
  // fired once they finish (it used to be silently ignored).
  const inFlight = useRef(0);
  const [sendQueued, setSendQueued] = useState(false);
  const uploadImage = useCallback(async (file: File) => {
    setError(null);
    inFlight.current += 1;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/paste-image", { method: "POST", body: fd });
      if (!r.ok) {
        const b = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(b?.error ?? `HTTP ${r.status}`);
      }
      const { path } = (await r.json()) as { path: string };
      setAttachments((prev) => [...prev, path]);
    } catch (err) {
      setError(`Screenshot didn't upload: ${(err as Error).message}`);
    } finally {
      inFlight.current = Math.max(0, inFlight.current - 1);
      if (inFlight.current === 0) setUploading(false);
    }
  }, []);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !uploading;

  // Same request shape as the hub tile QuickInputBar: text (+ screenshot
  // refs) joined by spaces, trailing "\r"; /api/pty-input splits the CR off
  // and writes it separately so Claude Code treats it as Enter.
  const send = async () => {
    const trimmed = text.trim();
    if (!canSend) return;
    setError(null);
    const parts: string[] = [];
    if (trimmed) parts.push(trimmed);
    for (const p of attachments) parts.push(`[screenshot image: "${p}"]`);
    const data = parts.join(" ") + "\r";
    const sentShots = attachments;
    setText("");
    setAttachments([]);
    stickRef.current = true;
    const pendingId = Date.now() + Math.random();
    if (trimmed) setPending((prev) => [...prev, { id: pendingId, text: trimmed, at: Date.now() }]);
    try {
      const r = await fetch("/api/pty-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, data, confirm: true }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(
          r.status === 404
            ? "This session isn't running in Mission Control. Open the terminal to resume it."
            : r.status === 409
              ? "That message didn't reach Claude (something on its screen ate the Enter). It's back in the box: press Enter to resend."
              : b?.error ?? `HTTP ${r.status}`,
        );
        if (r.status === 409) {
          // Put the failed message back without throwing away a newer draft.
          setText((cur) => (cur ? `${trimmed}\n${cur}` : trimmed));
          setAttachments((cur) => [...sentShots, ...cur]);
        }
        setPending((prev) => prev.filter((p) => p.id !== pendingId));
      }
    } catch (e) {
      setError((e as Error).message);
      setPending((prev) => prev.filter((p) => p.id !== pendingId));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (uploading) setSendQueued(true);
      else void send();
    }
  };
  useEffect(() => {
    if (sendQueued && !uploading) {
      setSendQueued(false);
      void send();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendQueued, uploading]);

  // Paste a screenshot anywhere on the page, not only inside the text box.
  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
        e.preventDefault();
        const f = it.getAsFile();
        if (f) void uploadImage(f);
      }
    };
    document.addEventListener("paste", onDocPaste);
    return () => document.removeEventListener("paste", onDocPaste);
  }, [uploadImage]);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
      e.preventDefault();
      const f = it.getAsFile();
      if (f) void uploadImage(f);
    }
  };

  const banner = isBlocked(snap) && pending.length === 0
    ? { text: "Claude is waiting for you in the terminal", sub: snap.attentionMessage, btn: "Open terminal" }
    : !snap.hubOwned
      ? { text: "This session isn't running right now", sub: "Open the terminal to resume it", btn: "Open terminal" }
      : null;

  return (
    <div className={`${s.root} flex min-h-0 flex-1 flex-col`}>
      <div ref={scrollRef} onScroll={onScroll} className={`${s.scroll} min-h-0 flex-1 overflow-y-auto`}>
        <div ref={contentRef} className="mx-auto w-full max-w-[760px] px-4 pb-10 pt-6 sm:px-6">
          {hiddenCount > 0 && (
            <div className="mb-8 flex justify-center">
              <button
                type="button"
                onClick={() => {
                  stickRef.current = false;
                  const el = scrollRef.current;
                  if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
                  setLimit((l) => l + MAX_RENDERED);
                }}
                className="rounded-full border border-[#2A2A2A] px-4 py-1.5 text-[13px] text-[#A3A3A3] transition hover:bg-[#1A1A1A] hover:text-white"
              >
                Show earlier messages
              </button>
            </div>
          )}
          {allTurns.length === 0 && (
            <div className="pt-[22vh] text-center text-[28px] font-medium tracking-[-0.02em] text-[#ECECEC]">
              What can I help with?
            </div>
          )}
          <div className="flex flex-col gap-7">
            {allTurns.map((t, i) =>
              t.kind === "user" ? (
                <UserBubble key={t.key} turn={t} />
              ) : (
                <AssistantTurn
                  key={t.key}
                  turn={t}
                  showActions={!(working && i === allTurns.length - 1)}
                />
              ),
            )}
            {working && (
              <div className="flex items-center gap-2 text-[14px] text-[#8A8A8A]">
                <span className={`${s.pulse} inline-block h-2 w-2 rounded-full bg-[#ECECEC]`} />
                <span className={s.pulse}>Thinking</span>
                {elapsed && <span className="tabular-nums text-[#6B6B6B]">· {elapsed}</span>}
              </div>
            )}
            {bg.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#2A2A2A] bg-[#0F0F0F] px-3.5 py-2.5 text-[13.5px]">
                <div className="flex items-center gap-2 text-[#ECECEC]">
                  <span className={`${s.pulse} inline-block h-2 w-2 rounded-full bg-[#F5B83D]`} />
                  {bg.length === 1 ? "1 helper still working" : `${bg.length} helpers still working`}
                  <span className="text-[#6B6B6B]">· Claude will report back when {bg.length === 1 ? "it's" : "they're"} done</span>
                </div>
                {bg.map((b) => (
                  <div key={b.id} className="flex items-baseline gap-2 pl-4 text-[#A3A3A3]">
                    <span className="min-w-0 flex-1 truncate">{b.label}</span>
                    <span className="shrink-0 tabular-nums text-[#6B6B6B]">{ago(Date.now() - b.since)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom input pill ───────────────────────────────────────── */}
      <div className="shrink-0 bg-black">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-3 sm:px-6 sm:pb-4">
          {banner && (
            <div className="mb-2.5 flex items-center gap-3 rounded-[16px] border border-[#5a4310] bg-[#1c1505] px-4 py-2.5 text-[14px] text-[#F5C451]">
              <span className="h-2 w-2 shrink-0 rounded-full bg-[#F5B83D]" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{banner.text}</div>
                {banner.sub && <div className="truncate text-[12.5px] text-[#C9A25A]">{banner.sub}</div>}
              </div>
              <button
                type="button"
                onClick={onOpenTerminal}
                className="shrink-0 rounded-full bg-[#F5C451] px-3.5 py-1.5 text-[13px] font-medium text-black transition hover:bg-[#ffd36e]"
              >
                {banner.btn}
              </button>
            </div>
          )}
          {error && <div className="mb-2 px-2 text-[13px] text-[#e07b7b]">{error}</div>}
          <div
            className="rounded-[28px] border border-[#2A2A2A] bg-[#111] transition-colors focus-within:border-[#3a3a3a]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const f = e.dataTransfer.files?.[0];
              if (f && f.type.startsWith("image/")) {
                e.preventDefault();
                void uploadImage(f);
              }
            }}
          >
            {(attachments.length > 0 || uploading) && (
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                {attachments.map((p, i) => (
                  <span key={p} title={p} className="inline-flex items-center gap-1.5 rounded-full border border-[#2A2A2A] bg-[#1A1A1A] py-1 pl-3 pr-1.5 text-[12.5px] text-[#C8C8C8]">
                    image {i + 1}
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((x) => x !== p))}
                      className="grid h-5 w-5 place-items-center rounded-full text-[#8A8A8A] hover:bg-[#2A2A2A] hover:text-white"
                      title="Remove"
                    >
                      <Icon size={12} d="M18 6L6 18M6 6l12 12" />
                    </button>
                  </span>
                ))}
                {uploading && <span className="px-2 py-1 text-[12.5px] text-[#737373]">Uploading…</span>}
              </div>
            )}
            <div className="flex min-h-[56px] items-end gap-1 py-[10px] pl-2.5 pr-2.5">
              <button
                type="button"
                title="Attach image"
                className={s.iconBtn}
                onClick={() => fileRef.current?.click()}
              >
                <Icon d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadImage(f);
                  e.target.value = "";
                }}
              />
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder="Ask anything"
                className={`${s.textarea} min-w-0 flex-1 self-center px-1.5 py-[6px]`}
              />
              <button
                type="button"
                title="Send"
                onClick={() => (uploading ? setSendQueued(true) : void send())}
                disabled={!canSend && !(uploading && text.trim().length > 0)}
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${canSend ? "bg-white text-black hover:bg-[#d9d9d9]" : "bg-[#2A2A2A] text-[#6b6b6b]"}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
                </svg>
              </button>
            </div>
          </div>
          <ContextLine snap={snap} />
        </div>
      </div>
    </div>
  );
}
