// Shared types for the session browser.
// A Session aggregates what was originally a stream of JSONL events into a
// flat, renderable timeline.

export type EventKind =
  | "user" // real user input (string content)
  | "assistant_text" // assistant markdown
  | "assistant_thinking" // thinking block (hidden by default)
  | "tool_use" // tool call
  | "tool_result" // tool output
  | "system" // system/meta (rare, mostly shown faded)
  | "permission"; // permission mode change

export type TimelineEvent = {
  kind: EventKind;
  ts: string; // ISO
  uuid: string;
  text?: string; // for user, assistant_text, assistant_thinking, system
  toolName?: string; // tool_use
  toolInput?: unknown; // tool_use
  toolUseId?: string; // tool_use and tool_result
  toolResultPreview?: string; // tool_result flattened to text
  toolResultIsError?: boolean;
  permissionMode?: string;
};

export type SessionSnapshot = {
  id: string; // sessionId (uuid)
  projectDir: string; // encoded project path (…/projects/<encoded>)
  projectLabel: string; // pretty label ("yscapp", "home")
  cwd: string; // last seen cwd
  gitBranch: string | null; // last seen git branch
  model: string; // last seen model
  modelDisplay: string; // "Opus 4.6"
  permissionMode: string | null; // last seen permission mode
  costUsd: number; // running total
  costExact: boolean; // true when sourced from patched statusline.cjs cache
  costKnown: boolean; // false for live sessions without a cache entry (show "—")
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  contextTokens: number; // sum of last assistant turn's input + cache read
  contextPct: number | null; // exact % from statusline cache, if known
  eventCount: number;
  firstUserMessage: string | null; // title
  firstTs: string | null;
  lastTs: string;
  lastEventKind: EventKind | null;
  recent: TimelineEvent[]; // last N timeline events for hub tile
  isLive: boolean; // mtime within LIVE_WINDOW_MS
  waitingForInput: boolean; // last assistant turn ended with end_turn, no newer user msg
  // Blocked on a permission prompt / question. Pushed by the Claude Code
  // Notification hook via POST /api/attention — it cannot be inferred from
  // the JSONL, because a session sitting on an allow/deny dialog still has
  // stop_reason "tool_use", which reads as "thinking" here.
  needsAttention: boolean;
  attentionMessage: string | null; // what it's asking for
  attentionTs: number; // epoch ms the hook fired
  ccVersion: string | null; // claude code version
  hubOwned: boolean; // pty-server holds this PTY → tile can reattach via /live/
};

export type CostEvent = { ts: number; usd: number };

export type FullSession = SessionSnapshot & {
  events: TimelineEvent[]; // full timeline for the detail view
  costEvents: CostEvent[]; // per-turn cost deltas, for startedAt-scoped recompute
};
