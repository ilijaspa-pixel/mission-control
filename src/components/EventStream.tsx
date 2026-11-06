"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { TimelineEvent } from "@/lib/types";

// Render markdown links as non-navigable spans. Prevents accidental navigation
// when a tile is clicked, and sidesteps any nested-anchor hydration warnings.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ children }) => (
    <span className="text-term-cyan underline decoration-term-cyan/40">
      {children}
    </span>
  ),
  // Wrap code blocks in a simple pre so Tailwind's `.md pre` rules apply
  // consistently without react-markdown reaching for syntax-highlighter libs.
  pre: ({ children }) => <pre>{children}</pre>,
};

type ToolInputShape = Record<string, unknown> | undefined;

function summarizeToolInput(name: string, input: ToolInputShape): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  // Tool-specific pretty summaries
  switch (name) {
    case "Bash":
      return String(o.command ?? "").slice(0, 240);
    case "Read":
    case "Write":
    case "Edit":
      return String(o.file_path ?? o.path ?? "").split("/").slice(-3).join("/");
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
    case "TaskCreate": {
      const subject = o.subject ?? (Array.isArray(o.todos) ? `${(o.todos as unknown[]).length} todos` : "");
      return String(subject ?? "");
    }
    case "TaskUpdate":
      return `${o.taskId ?? ""} → ${o.status ?? ""}`;
    default: {
      // Generic: show 1–2 short string fields
      const pairs: string[] = [];
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && v.length < 80) pairs.push(`${k}=${v}`);
        if (pairs.length >= 2) break;
      }
      return pairs.join("  ");
    }
  }
}

function cleanAssistantText(text: string): string {
  // Strip hidden system-reminder blocks (Claude Code injects them) and
  // command-name tags that shouldn't bleed into user-visible rendering.
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-(?:name|args|message)>[\s\S]*?<\/command-[^>]+>/g, "")
    .trim();
}

export function EventStream({
  events,
  dense = false,
}: {
  events: TimelineEvent[];
  dense?: boolean;
}) {
  const gap = dense ? "gap-[6px]" : "gap-3";
  const textSize = dense ? "text-[13px] leading-[1.55]" : "text-[14px] leading-[1.65]";

  return (
    <div className={`flex flex-col ${gap} ${textSize} font-sans`}>
      {events.map((ev, i) => (
        // Index suffix guarantees uniqueness even if two events somehow share a uuid.
        <EventRow key={`${ev.uuid}#${i}`} ev={ev} dense={dense} />
      ))}
    </div>
  );
}

function EventRow({ ev, dense }: { ev: TimelineEvent; dense: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (ev.kind === "user") {
    const text = (ev.text ?? "").trim();
    if (!text || text.startsWith("<system-reminder>")) return null;
    // Collapse `[screenshot image: "/long/path.jpg"]` into a compact chip —
    // the full path is useful to claude but visual noise in the UI.
    const SHOT_RE = /\[screenshot image:\s*"([^"]+)"\]/g;
    const parts: Array<{ kind: "text" | "shot"; value: string }> = [];
    let lastIdx = 0;
    for (const m of text.matchAll(SHOT_RE)) {
      if (m.index! > lastIdx) {
        parts.push({ kind: "text", value: text.slice(lastIdx, m.index) });
      }
      parts.push({ kind: "shot", value: m[1] });
      lastIdx = m.index! + m[0].length;
    }
    if (lastIdx < text.length) {
      parts.push({ kind: "text", value: text.slice(lastIdx) });
    }
    return (
      <div className="flex gap-2">
        <span className="shrink-0 select-none text-term-user">&gt;</span>
        <span className="whitespace-pre-wrap break-words font-medium text-term-user">
          {parts.map((p, i) =>
            p.kind === "text" ? (
              <span key={i}>{p.value}</span>
            ) : (
              <span
                key={i}
                title={p.value}
                className="mx-1 inline-flex items-center gap-1 rounded-[4px] border border-term-violet/40 bg-term-violet/10 px-1.5 py-[1px] text-[10.5px] text-term-violet"
              >
                📎 screenshot
              </span>
            ),
          )}
        </span>
      </div>
    );
  }

  if (ev.kind === "assistant_text") {
    const text = cleanAssistantText(ev.text ?? "");
    if (!text) return null;
    const preview = text;
    return (
      <div className="md text-ink">
        <ReactMarkdown components={MARKDOWN_COMPONENTS}>
          {preview}
        </ReactMarkdown>
      </div>
    );
  }

  if (ev.kind === "assistant_thinking") {
    if (dense) return null; // hide thinking blocks in tile view
    const text = ev.text ?? "";
    return (
      <details className="rounded border border-edge/60 bg-bg-header px-2 py-1 text-ink-muted">
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-ink-faint">
          thinking · {text.length} chars
        </summary>
        <div className="mt-2 whitespace-pre-wrap text-[11.5px] italic text-ink-dim">
          {text}
        </div>
      </details>
    );
  }

  if (ev.kind === "tool_use") {
    const summary = summarizeToolInput(ev.toolName ?? "", ev.toolInput as ToolInputShape);
    return (
      <div className="flex gap-2">
        <span className="shrink-0 select-none text-term-cyan">●</span>
        <div className="min-w-0 flex-1 break-words">
          <span className="font-medium text-term-cyan">
            {ev.toolName}
          </span>
          {summary && (
            // Shell commands and paths — monospace, whatever the prose uses.
            <span className="font-mono text-[0.92em] text-ink-muted">
              {" "}
              <span className="text-ink-faint">(</span>
              {summary}
              <span className="text-ink-faint">)</span>
            </span>
          )}
        </div>
      </div>
    );
  }

  if (ev.kind === "tool_result") {
    const text = (ev.toolResultPreview ?? "").trim();
    if (!text) return null;
    const isError = ev.toolResultIsError;
    const preview = expanded ? text : text.slice(0, 1_200);
    return (
      <div
        className={`ml-3 border-l-2 pl-2 ${isError ? "border-term-red" : "border-edge"}`}
      >
        <div
          className={`whitespace-pre-wrap break-words font-mono text-[0.92em] ${isError ? "text-term-red" : "text-ink-dim"}`}
        >
          {preview}
          {!dense && text.length > preview.length && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className="ml-2 text-[10px] uppercase tracking-wider text-term-violet hover:underline"
            >
              {expanded ? "collapse" : `+${text.length - preview.length} more`}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (ev.kind === "permission") {
    return (
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">
        · permission → {ev.permissionMode}
      </div>
    );
  }

  return null;
}
