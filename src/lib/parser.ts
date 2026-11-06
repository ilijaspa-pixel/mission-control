// Parses Claude Code JSONL session files into flat SessionSnapshots.
// Designed for incremental use: call parseLines() to process any newly-appended
// lines and fold them into an existing snapshot.

import { costForUsage, displayModel, type Usage } from "./pricing";
import type {
  EventKind,
  SessionSnapshot,
  TimelineEvent,
  FullSession,
} from "./types";

const RECENT_CAP = 60; // lines shown in hub tile
const FULL_CAP = 5_000; // safety cap for full detail view

export function emptySnapshot(id: string, projectDir: string): FullSession {
  return {
    id,
    projectDir,
    projectLabel: projectLabelFor(projectDir),
    cwd: "",
    gitBranch: null,
    model: "claude-opus-4-6",
    modelDisplay: "Opus 4.6",
    permissionMode: null,
    costUsd: 0,
    costExact: false,
    costKnown: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    contextTokens: 0,
    contextPct: null,
    eventCount: 0,
    firstUserMessage: null,
    firstTs: null,
    lastTs: "",
    lastEventKind: null,
    recent: [],
    events: [],
    costEvents: [],
    isLive: false,
    waitingForInput: false,
    needsAttention: false,
    attentionMessage: null,
    attentionTs: 0,
    ccVersion: null,
    hubOwned: false,
  };
}

/** "~/.claude/projects/-Users-ilijaspasic-yscapp" -> "yscapp".
 *  Alt-install projects are prefixed with "alt::" in the store and
 *  surface as e.g. "yscapp (alt)" to distinguish them visibly. */
export function projectLabelFor(projectDir: string): string {
  const isAlt = projectDir.startsWith("alt::");
  const bareDir = isAlt ? projectDir.slice(5) : projectDir;
  const base = bareDir.split(/[\\/]/).pop() ?? bareDir;
  const parts = base.replace(/^-+/, "").split("-").filter(Boolean);
  const label =
    parts.length > 0 ? parts[parts.length - 1] : base;
  return isAlt ? `${label} (alt)` : label;
}

type RawLine = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  permissionMode?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Usage;
    stop_reason?: string;
    stopReason?: string;
  };
  isSidechain?: boolean;
  attachment?: unknown;
};

/**
 * Parse newly-appended lines and fold them into `snap`. Mutates `snap`.
 * Returns the list of newly-created TimelineEvents (for diff streaming).
 */
export function parseLines(
  snap: FullSession,
  rawLines: string[],
): TimelineEvent[] {
  const added: TimelineEvent[] = [];

  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    let ev: RawLine;
    try {
      ev = JSON.parse(raw) as RawLine;
    } catch {
      continue;
    }

    // Skip subagent sidechains — they're noise for the main view
    if (ev.isSidechain) continue;

    if (ev.cwd && !snap.cwd) snap.cwd = ev.cwd;
    if (ev.cwd) snap.cwd = ev.cwd;
    if (ev.gitBranch) snap.gitBranch = ev.gitBranch;
    if (ev.version) snap.ccVersion = ev.version;
    if (ev.timestamp) {
      if (!snap.firstTs) snap.firstTs = ev.timestamp;
      snap.lastTs = ev.timestamp;
    }

    // Any transcript line written AFTER the Notification hook fired means the
    // session got unblocked and moved on — clear the attention flag. Keyed on
    // timestamp rather than event type because approving a permission prompt
    // produces a tool_result, not a user text message, so the flag would
    // otherwise stick until the next typed prompt.
    if (snap.needsAttention && ev.timestamp) {
      const evMs = new Date(ev.timestamp).getTime();
      if (Number.isFinite(evMs) && evMs > snap.attentionTs) {
        snap.needsAttention = false;
        snap.attentionMessage = null;
      }
    }

    if (ev.type === "permission-mode" && ev.permissionMode) {
      snap.permissionMode = ev.permissionMode;
      const tev: TimelineEvent = {
        kind: "permission",
        ts: ev.timestamp ?? snap.lastTs,
        uuid: ev.uuid ?? `pm-${snap.events.length}`,
        permissionMode: ev.permissionMode,
      };
      pushEvent(snap, tev, added);
      continue;
    }

    if (ev.type === "user") {
      // Any real user input means the session is no longer waiting —
      // Claude is about to take a turn.
      const c = ev.message?.content;
      // Turns that end with no assistant reply after them: an Esc interrupt and a local slash
      // command's output. Nothing else would clear "working", so the chat said Thinking forever.
      const asText = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b?.text ?? "").join(" ") : "";
      if (/^\s*\[Request interrupted by user/.test(asText) || /^\s*<local-command-(stdout|stderr)>/.test(asText)) {
        snap.waitingForInput = true;
      } else if (typeof c === "string" && c.trim() && !looksLikeSystemPreamble(c)) {
        snap.waitingForInput = false;
        // The user answered — whatever the hook was flagging is resolved.
        snap.needsAttention = false;
        snap.attentionMessage = null;
      }
      const baseUuid = ev.uuid ?? `u-${snap.events.length}`;
      const content = ev.message?.content;
      if (typeof content === "string") {
        const text = content.trim();
        // First real user message becomes the title
        if (!snap.firstUserMessage && text && !looksLikeSystemPreamble(text)) {
          snap.firstUserMessage = text.slice(0, 200);
        }
        pushEvent(
          snap,
          {
            kind: "user",
            ts: ev.timestamp ?? snap.lastTs,
            uuid: baseUuid,
            text,
          },
          added,
        );
      } else if (Array.isArray(content)) {
        let blockIdx = 0;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "tool_result") {
            const flat = flattenToolResult(block.content);
            pushEvent(
              snap,
              {
                kind: "tool_result",
                ts: ev.timestamp ?? snap.lastTs,
                uuid: `${baseUuid}:tr${blockIdx}`,
                toolUseId: (block.tool_use_id as string) ?? undefined,
                toolResultPreview: flat.slice(0, 2_000),
                toolResultIsError: block.is_error === true,
              },
              added,
            );
          } else if (block.type === "text" && typeof block.text === "string") {
            pushEvent(
              snap,
              {
                kind: "user",
                ts: ev.timestamp ?? snap.lastTs,
                uuid: `${baseUuid}:u${blockIdx}`,
                text: block.text,
              },
              added,
            );
          }
          blockIdx++;
        }
      }
      continue;
    }

    if (ev.type === "assistant") {
      const msg = ev.message;
      if (!msg) continue;
      // An assistant message with stop_reason "end_turn" means Claude has
      // finished its turn and is waiting for the next user input. Any other
      // stop reason (tool_use, max_tokens, etc.) means it's still working.
      const stop = msg.stop_reason ?? msg.stopReason;
      if (stop === "end_turn") {
        snap.waitingForInput = true;
      } else if (stop && stop !== "end_turn") {
        snap.waitingForInput = false;
      }
      if (msg.model) {
        snap.model = msg.model;
        snap.modelDisplay = displayModel(msg.model);
      }
      if (msg.usage) {
        const delta = costForUsage(msg.model ?? snap.model, msg.usage);
        snap.costUsd += delta;
        // Record per-turn cost with timestamp so we can recompute cost scoped
        // to the current Warp's Claude Code process lifetime (events after
        // its startedAt) when no status-cache entry is available.
        const tsMs = ev.timestamp ? new Date(ev.timestamp).getTime() : Date.now();
        snap.costEvents.push({ ts: tsMs, usd: delta });
        if (snap.costEvents.length > 10_000) {
          snap.costEvents.splice(0, snap.costEvents.length - 10_000);
        }
        snap.totalInputTokens += msg.usage.input_tokens ?? 0;
        snap.totalOutputTokens += msg.usage.output_tokens ?? 0;
        snap.totalCacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
        // "Context tokens" = how full the current window is. Best approximation:
        // last assistant turn's input + cache read + cache create + output.
        snap.contextTokens =
          (msg.usage.input_tokens ?? 0) +
          (msg.usage.cache_read_input_tokens ?? 0) +
          (msg.usage.cache_creation_input_tokens ?? 0) +
          (msg.usage.output_tokens ?? 0);
      }
      const baseUuid = ev.uuid ?? `a-${snap.events.length}`;
      const content = msg.content;
      if (Array.isArray(content)) {
        let blockIdx = 0;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            const text = block.text.trim();
            if (text) {
              pushEvent(
                snap,
                {
                  kind: "assistant_text",
                  ts: ev.timestamp ?? snap.lastTs,
                  uuid: `${baseUuid}:txt${blockIdx}`,
                  text,
                },
                added,
              );
            }
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string"
          ) {
            const text = block.thinking.trim();
            if (text) {
              pushEvent(
                snap,
                {
                  kind: "assistant_thinking",
                  ts: ev.timestamp ?? snap.lastTs,
                  uuid: `${baseUuid}:thk${blockIdx}`,
                  text,
                },
                added,
              );
            }
          } else if (block.type === "tool_use") {
            // Prefer the tool_use block id as the uuid key — it's globally unique.
            const tid = (block.id as string) || `${baseUuid}:tu${blockIdx}`;
            pushEvent(
              snap,
              {
                kind: "tool_use",
                ts: ev.timestamp ?? snap.lastTs,
                uuid: tid,
                toolName: (block.name as string) ?? "Tool",
                toolInput: block.input,
                toolUseId: (block.id as string) ?? undefined,
              },
              added,
            );
          }
          blockIdx++;
        }
      }
      continue;
    }

    // A message typed while Claude was mid-turn is logged as a
    // "queued_command" attachment, not a user entry. Show it as the user's
    // message so it isn't lost, but don't flip waitingForInput: it was
    // consumed inside the turn that was already running.
    if (ev.type === "attachment") {
      const att = ev.attachment as { type?: string; prompt?: unknown } | undefined;
      if (att?.type === "queued_command" && typeof att.prompt === "string" && att.prompt.trim()) {
        pushEvent(
          snap,
          {
            kind: "user",
            ts: ev.timestamp ?? snap.lastTs,
            uuid: ev.uuid ?? `q-${snap.events.length}`,
            text: att.prompt.trim(),
          },
          added,
        );
      }
      continue;
    }

    // Silently skip file-history-snapshot, system, etc.
  }

  return added;
}

function pushEvent(
  snap: FullSession,
  ev: TimelineEvent,
  added: TimelineEvent[],
): void {
  snap.events.push(ev);
  if (snap.events.length > FULL_CAP) {
    snap.events.splice(0, snap.events.length - FULL_CAP);
  }
  snap.recent = snap.events.slice(-RECENT_CAP);
  snap.lastEventKind = ev.kind;
  snap.eventCount += 1;
  added.push(ev);
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) {
          return String((b as Record<string, unknown>).text ?? "");
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function looksLikeSystemPreamble(text: string): boolean {
  // Auto-injected context like <system-reminder> or caveat blocks shouldn't
  // become the session title.
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("<command-") ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("Caveat:")
  );
}
