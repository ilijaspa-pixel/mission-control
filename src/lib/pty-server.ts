// WebSocket PTY bridge.
//
// Runs a standalone ws server on port 4101 alongside Next.js. Each client
// connection maps 1:1 to a node-pty child process running the Claude Code
// CLI. Bytes flow both ways: what the client types is piped into the PTY's
// stdin; what the PTY writes (Claude's TUI output) is streamed back to the
// client for xterm.js to render.
//
// Wire protocol (JSON messages over the WebSocket):
//   client → server:
//     { "type": "input",  "data": string }      // bytes to write to PTY stdin
//     { "type": "resize", "cols": n, "rows": n } // resize PTY
//     { "type": "kill" }                         // terminate PTY
//   server → client:
//     { "type": "data",    "data": string }      // bytes from PTY stdout
//     { "type": "session", "id": string }        // discovered claude session uuid
//     { "type": "exit",    "code": n }           // PTY exited
//     { "type": "error",   "message": string }
//
// Sessions: the client opens /pty?session=<id>&mode=<resume|new>.
//   - resume: if an existing in-memory PTY has this claude session id,
//             reattach the new ws to it (replays buffered output, cancels
//             the reaper). Otherwise spawn `claude -r <id>`.
//   - new:    spawn `claude` and start polling ~/.claude/sessions/<pid>.json
//             to discover claude's session uuid; tell the client over the
//             ws so it can update its URL to /live/<uuid>.
//
// Lifetime: a PTY survives ws disconnect indefinitely. When the client
// navigates back to the hub, we detach the ws but keep claude running.
// The user can re-enter from the tile and pick up where they left off.
// Sessions only die when the user explicitly closes them (× button).
//
// Persistence: the ws server binds exactly once per process. We store the
// instance on globalThis so Next.js Fast Refresh doesn't double-bind.
// Additionally, session metadata is persisted to disk so server restarts
// can re-adopt orphaned Claude processes (see PERSIST_PATH below).

import { execFileSync } from "node:child_process";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import type { WebSocket, WebSocketServer } from "ws";

import { registerAlias } from "./live-detect";

const PORT = 4101;
const BIND = "127.0.0.1";

// ── Session persistence across server restarts ──────────────────────
// When the Next.js dev server restarts, all in-memory session state is
// lost — but the Claude child processes survive as orphans. We persist
// critical metadata to disk so on startup we can re-adopt any sessions
// whose PIDs are still alive. Re-adopted sessions appear as hub-owned
// tiles; when a client connects to one, it sees ptyExited=true (no real
// PTY handle) and falls through to spawning a fresh `claude --resume`.
const PERSIST_PATH = path.join(
  os.homedir(),
  ".claude",
  "mission-control-sessions.json",
);
const PERSIST_DEBOUNCE_MS = 2_000;

type PersistedSession = {
  claudeSessionId: string;
  pid: number;
  startedAt: number;
  key: string;
  // Flavor at spawn time — preserved so a dev-server restart (or mac sleep
  // that killed the children) can respawn claude2 sessions with the right
  // CLAUDE_CONFIG_DIR and cwd instead of silently losing them.
  flavor?: "claude" | "claude2";
};
type PersistenceFile = { sessions: PersistedSession[] };

let _persistTimer: NodeJS.Timeout | null = null;

function persistSessionsNow(state: PtyServerState) {
  const entries: PersistedSession[] = [];
  for (const [, session] of state.byClaudeId) {
    if (!session.claudeSessionId) continue;
    const pid = session.pty?.pid ?? session._orphanPid;
    if (!pid) continue;
    entries.push({
      claudeSessionId: session.claudeSessionId,
      pid,
      startedAt: session.startedAt,
      key: session.key,
      flavor: session.flavor ?? "claude",
    });
  }
  const payload: PersistenceFile = { sessions: entries };
  try {
    const dir = path.dirname(PERSIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = PERSIST_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, PERSIST_PATH);
  } catch (err) {
    console.error(
      "[pty-server] persist write failed:",
      (err as Error).message,
    );
  }
}

function persistSessions(state: PtyServerState) {
  if (_persistTimer) return; // already scheduled
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistSessionsNow(state);
  }, PERSIST_DEBOUNCE_MS);
}

function loadPersistedSessions(): PersistedSession[] {
  try {
    const raw = fs.readFileSync(PERSIST_PATH, "utf8");
    const data = JSON.parse(raw) as PersistenceFile;
    if (Array.isArray(data.sessions)) return data.sessions;
  } catch {
    // File missing or corrupt — nothing to restore.
  }
  return [];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal
    return true;
  } catch {
    return false;
  }
}

// Orphaned PTY reaping is DISABLED. Sessions stay alive indefinitely after
// WebSocket disconnect — they only die when the user explicitly closes them
// (the × button sends {type:"kill"}). The old 4-hour reaper was killing
// sessions the user still wanted.

// Build the spawn args/cwd/env for a given claude session, preserving flavor.
// Used by both the initial spawn in handleConnection and the auto-restart
// helpers so claude2 sessions always get the right CLAUDE_CONFIG_DIR / cwd.
function buildResumeSpawn(
  claudeId: string,
  flavor: "claude" | "claude2" = "claude",
): { args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const args = [...CLAUDE_LAUNCHER.baseArgs, "--resume", claudeId];
  if (flavor === "claude2" && !args.includes("--dangerously-skip-permissions")) {
    args.push("--dangerously-skip-permissions");
  }
  const cwd =
    flavor === "claude2"
      ? path.join(os.homedir(), "yscapp")
      : os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(os.homedir(), ".npm-global", "bin")}:${path.join(os.homedir(), "bin")}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  };
  if (flavor === "claude2") {
    env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude-alt");
  }
  return { args, cwd, env };
}

// How much PTY output to buffer for replay on reattach. Claude is a TUI
// app and does periodic full-screen repaints, so the last 256 KB is more
// than enough to reconstruct the visible state.
const REPLAY_BUFFER_BYTES = 256 * 1024;

// Polling cadence for ~/.claude/sessions/<pid>.json after spawn. Claude
// writes its pidfile within ~100ms of startup; give up after 30s.
const SESSION_ID_POLL_MS = 400;
const SESSION_ID_POLL_TIMEOUT_MS = 30_000;

const SESSION_DIRS = [
  path.join(os.homedir(), ".claude", "sessions"),
  path.join(os.homedir(), ".claude-alt", "sessions"),
];

// Resolve a concrete exec+args pair for launching claude in a child PTY.
//
// The npm-global `claude` binary is a JS file (cli.js) with a shebang
// `#!/usr/bin/env node`. When node-pty calls posix_spawnp on it, the shebang
// interpreter has to be resolved via the child's PATH — and dev-server
// environments often have a sparser PATH that can't find `node`, so the
// spawn fails with the unhelpful "posix_spawnp failed".
//
// The robust fix is to skip the shebang entirely: resolve the real cli.js
// path (following the symlink at `~/.npm-global/bin/claude`) and spawn
// `node /abs/path/to/cli.js` directly. That works regardless of PATH.
// Windows: npm installs `claude.cmd` (a wrapper around cli.js) and the native installer
// puts `claude.exe` in ~/.local/bin. ConPTY can't run a .cmd directly, so for npm installs
// we spawn node with the package's cli.js, same idea as the Mac path below.
function resolveClaudeLauncherWindows(): { cmd: string; baseArgs: string[] } {
  let hits: string[] = [];
  try {
    hits = execFileSync("where", ["claude"], { encoding: "utf8", env: process.env })
      .toString()
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    // fall through
  }
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe")) ?? [path.join(os.homedir(), ".local", "bin", "claude.exe")].find((f) => fs.existsSync(f));
  if (exe) return { cmd: exe, baseArgs: [] };
  const npmDirs = [
    ...hits.filter((h) => /\.(cmd|ps1)$/i.test(h)).map((h) => path.dirname(h)),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "npm"),
  ];
  for (const dir of npmDirs) {
    for (const rel of [["@anthropic-ai", "claude-code", "cli.js"], ["@anthropic-ai", "claude-code", "cli.mjs"]]) {
      const cli = path.join(dir, "node_modules", ...rel);
      if (fs.existsSync(cli)) return { cmd: process.execPath, baseArgs: [cli] };
    }
  }
  const cmd = hits.find((h) => h.toLowerCase().endsWith(".cmd"));
  if (cmd) return { cmd: "cmd.exe", baseArgs: ["/c", cmd] };
  return { cmd: "claude.exe", baseArgs: [] };
}

function resolveClaudeLauncher(): { cmd: string; baseArgs: string[] } {
  if (process.platform === "win32") return resolveClaudeLauncherWindows();
  // 1) locate the `claude` binary on disk
  let binPath = "";
  try {
    const out = execFileSync("/usr/bin/which", ["claude"], {
      encoding: "utf8",
      env: process.env,
    })
      .toString()
      .trim();
    if (out && fs.existsSync(out)) binPath = out;
  } catch {
    // fall through
  }
  if (!binPath) {
    const fallbacks = [
      path.join(os.homedir(), ".npm-global", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ];
    for (const f of fallbacks) {
      if (fs.existsSync(f)) {
        binPath = f;
        break;
      }
    }
  }
  // 2) follow symlinks → real cli.js
  let realPath = binPath;
  try {
    realPath = fs.realpathSync(binPath);
  } catch {
    // keep binPath
  }
  // 3) if it's a JS file, spawn node <cli.js>; otherwise spawn the binary directly
  if (realPath.endsWith(".js") || realPath.endsWith(".mjs")) {
    return { cmd: process.execPath, baseArgs: [realPath] };
  }
  return { cmd: binPath || "claude", baseArgs: [] };
}
const CLAUDE_LAUNCHER = resolveClaudeLauncher();

type Session = {
  // Internal map key. Initially `new-${pid}` for fresh spawns; switched
  // to the claude session UUID once discovered via the pidfile so future
  // /live/<uuid> requests find it.
  key: string;
  pty: IPty;
  // Active client WebSocket, or null when detached. PTY survives detach.
  ws: WebSocket | null;
  startedAt: number;
  // Claude Code's own session UUID, discovered from
  // ~/.claude/sessions/<pid>.json. Null until claude has booted enough
  // to write its pidfile.
  claudeSessionId: string | null;
  // Rolling buffer of stdout for replay on reattach. Capped to
  // REPLAY_BUFFER_BYTES. Only used when there's no complete `vt` (sessions
  // that were already running before the headless terminal existed).
  buffer: string;
  // Headless copy of the screen, fed every byte the PTY writes. On reattach
  // we send its serialized state (exactly what the screen shows) instead of
  // replaying raw bytes, which cut mid-frame and smeared the console.
  // `complete` = it has seen this PTY's output from the very start.
  vt?: { term: HeadlessTerminal; ser: SerializeAddon; complete: boolean } | null;
  // While a reattach is waiting for the vt to finish parsing, live chunks are
  // held here and flushed right after the snapshot, so nothing is lost or
  // duplicated.
  attachPending?: string[] | null;
  // Reaper timer set when the WS detaches. Cleared on reattach or kill.
  reapTimer: NodeJS.Timeout | null;
  // Polling timer for claude session id discovery. Cleared once found
  // or on timeout.
  pollTimer: NodeJS.Timeout | null;
  // True once the PTY child process has exited (crash, OOM, auto-update).
  // Also true for re-adopted sessions that have no PTY handle.
  // The session stays in the maps for a grace period so the hub tile
  // doesn't flicker and a reconnecting client can fall through to a
  // fresh spawn.
  ptyExited: boolean;
  // Grace timer started when the PTY exits. After 2 minutes with no
  // client reconnection, the session is finally removed from maps.
  graceTimer: NodeJS.Timeout | null;
  // PID of the orphaned Claude process, set only for re-adopted sessions
  // that have no PTY handle. Used for persistence bookkeeping.
  _orphanPid?: number;
  // Flavor used at spawn time — preserved so auto-restart reuses the
  // same cwd/env (especially CLAUDE_CONFIG_DIR for claude2 sessions).
  flavor?: "claude" | "claude2";
  // Set by destroySession: this session was killed on purpose and must
  // never come back. The onExit closure still lives on the child after
  // destroySession has dropped the session from the maps, so without this
  // tombstone an explicit kill races straight into the auto-restart branch
  // and resurrects the session the user just closed.
  destroyed?: boolean;
  // Timestamp of the most recent spawn/respawn of this session's child, and
  // a count of restarts where the child died almost immediately. The
  // per-exit MAX_ATTEMPTS cap only covers spawn() throwing; a child that
  // spawns fine and then exits straight away re-enters onPtyExit and starts
  // a fresh attempt-1 loop, so the crash loop needs its own counter.
  lastSpawnAt?: number;
  rapidRestarts?: number;
};

type PtyServerState = {
  wss: WebSocketServer | null;
  // Indexed by internal key (initially `new-${pid}`, then claude session UUID).
  sessions: Map<string, Session>;
  // Indexed by claude session UUID once discovered. Used for reattach lookup
  // and to expose the "hub-owned" set to the rest of the app.
  byClaudeId: Map<string, Session>;
  port: number;
  started: boolean;
  // Live pointer to the current handleConnection. Re-bound on every module
  // evaluation so Next.js dev hot-reload picks up edits to the spawn logic
  // without needing a full server restart. The wss callback closure (set
  // once at first startup) reads this fresh on every connection.
  handleConnection?: (ws: WebSocket, req: { url?: string }) => Promise<void>;
};

const KEY = Symbol.for("claude-session-browser.pty-server");
type G = typeof globalThis & { [KEY]?: PtyServerState };
const g = globalThis as G;

if (!g[KEY]) {
  g[KEY] = {
    wss: null,
    sessions: new Map(),
    byClaudeId: new Map(),
    port: PORT,
    started: false,
  };
}
// Defensive: a previous version of this module persisted g[KEY] without
// `byClaudeId`. Patch in place so dev hot-reload doesn't crash before the
// next full process restart.
if (!g[KEY]!.byClaudeId) {
  g[KEY]!.byClaudeId = new Map();
}

function parseUrl(u: string): {
  session: string | null;
  mode: string;
  flavor: "claude" | "claude2";
  cols: number;
  rows: number;
} {
  // u looks like "/pty?session=abc&mode=new&flavor=claude2&cols=180&rows=44"
  // Everything is inlined here on purpose: a newly added top-level helper in
  // this module goes missing under Next's server hot-reload (the connection
  // handler is re-dereferenced per connection, but a fresh sibling binding
  // isn't always in the reloaded scope), which throws on every connect.
  const DEF_COLS = 120;
  const DEF_ROWS = 32;
  const qIdx = u.indexOf("?");
  if (qIdx === -1)
    return {
      session: null,
      mode: "new",
      flavor: "claude",
      cols: DEF_COLS,
      rows: DEF_ROWS,
    };
  const params = new URLSearchParams(u.slice(qIdx + 1));
  const rawFlavor = params.get("flavor");
  const flavor: "claude" | "claude2" =
    rawFlavor === "claude2" ? "claude2" : "claude";
  // The browser measures its own cell grid and sends it on connect, so the
  // PTY can be born at the right width instead of being resized after Claude
  // has already drawn its first frame at some other column count. Clamp hard:
  // a bogus or zero value here would spawn an unusable terminal.
  const nCols = Number.parseInt(params.get("cols") ?? "", 10);
  const nRows = Number.parseInt(params.get("rows") ?? "", 10);
  return {
    session: params.get("session"),
    mode: params.get("mode") ?? "new",
    flavor,
    cols: Number.isFinite(nCols) && nCols >= 2 && nCols <= 1000 ? nCols : DEF_COLS,
    rows: Number.isFinite(nRows) && nRows >= 2 && nRows <= 1000 ? nRows : DEF_ROWS,
  };
}

function safeSend(ws: WebSocket | null, obj: unknown) {
  if (!ws) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // client gone; ignore
  }
}

function appendToBuffer(session: Session, data: string) {
  session.buffer += data;
  if (session.buffer.length > REPLAY_BUFFER_BYTES) {
    session.buffer = session.buffer.slice(
      session.buffer.length - REPLAY_BUFFER_BYTES,
    );
  }
}

function ensureVt(session: Session) {
  if (session.vt) return session.vt;
  const cols = session.pty?.cols || 120;
  const rows = session.pty?.rows || 32;
  const term = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const ser = new SerializeAddon();
  term.loadAddon(ser as never);
  // Complete only if nothing was written before it existed.
  session.vt = { term, ser, complete: session.buffer.length === 0 };
  return session.vt;
}

function resetVt(session: Session) {
  try {
    session.vt?.term.dispose();
  } catch {}
  session.vt = null;
}

function resizeVt(session: Session, cols: number, rows: number) {
  try {
    session.vt?.term.resize(cols, rows);
  } catch {}
}

// Every PTY output chunk goes through here: replay buffer, headless screen,
// and the attached client (or the pending queue during a reattach).
function emitData(session: Session, data: string) {
  const vt = ensureVt(session);
  appendToBuffer(session, data);
  try {
    vt.term.write(data);
  } catch {}
  if (session.attachPending) session.attachPending.push(data);
  else safeSend(session.ws, { type: "data", data });
}

function readClaudePidFile(pid: number): string | null {
  for (const dir of SESSION_DIRS) {
    const file = path.join(dir, `${pid}.json`);
    try {
      const raw = fs.readFileSync(file, "utf8");
      const obj = JSON.parse(raw) as { sessionId?: string };
      if (obj.sessionId) return obj.sessionId;
    } catch {
      // not yet written; try the other dir
    }
  }
  return null;
}

function startSessionIdPoll(state: PtyServerState, session: Session) {
  // Resume sessions already know their id; nothing to discover.
  if (session.claudeSessionId) return;
  const startedAt = Date.now();
  const tick = () => {
    if (session.claudeSessionId) {
      if (session.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
      }
      return;
    }
    if (Date.now() - startedAt > SESSION_ID_POLL_TIMEOUT_MS) {
      console.warn(
        `[pty-server] ${session.key} timed out waiting for claude session id`,
      );
      if (session.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
      }
      return;
    }
    const id = readClaudePidFile(session.pty.pid);
    if (!id) return;
    session.claudeSessionId = id;
    state.byClaudeId.set(id, session);
    persistSessions(state);
    // Re-key the session under its real claude id so /live/<uuid> requests
    // can find it via state.sessions too. Drop the old `new-${pid}` key.
    if (session.key !== id) {
      state.sessions.delete(session.key);
      session.key = id;
      state.sessions.set(id, session);
    }
    // Tell the client so it can update its URL from /live/new to
    // /live/<uuid> — without that, "back to mission control" → click tile
    // would route to /live/new again and spawn a duplicate.
    safeSend(session.ws, { type: "session", id });
    console.log(
      `[pty-server] ${session.key} learned claudeSessionId=${id} pid=${session.pty.pid}`,
    );
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
  };
  // Tick once immediately so fast spawns get the id without waiting.
  tick();
  if (!session.claudeSessionId) {
    session.pollTimer = setInterval(tick, SESSION_ID_POLL_MS);
  }
}

function destroySession(
  state: PtyServerState,
  session: Session,
  reason: string,
) {
  const pid = session.pty?.pid ?? session._orphanPid ?? "?";
  console.log(
    `[pty-server] ${session.key} destroying (${reason}) pid=${pid}`,
  );
  // Tombstone BEFORE the kill, so the exit we are about to cause can't be
  // mistaken for a crash and auto-restarted.
  session.destroyed = true;
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  if (session.reapTimer) {
    clearTimeout(session.reapTimer);
    session.reapTimer = null;
  }
  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  // SIGTERM first for graceful shutdown, SIGKILL after a beat. Claude
  // catches SIGHUP/SIGINT and runs a shutdown routine that can hang.
  // For re-adopted sessions (no PTY handle), kill the orphan PID directly.
  if (session.pty) {
    try {
      session.pty.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        session.pty.kill("SIGKILL");
      } catch {}
      // Hand the pty's master fd back to the kernel. Killing the child is
      // not enough — the fd lives on this side of the pipe.
      try {
        (session.pty as unknown as { destroy?: () => void }).destroy?.();
      } catch {}
    }, 800);
  } else if (session._orphanPid) {
    try {
      process.kill(session._orphanPid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(session._orphanPid!, "SIGKILL");
      } catch {}
    }, 800);
  }
  state.sessions.delete(session.key);
  if (session.claudeSessionId) {
    state.byClaudeId.delete(session.claudeSessionId);
  }
  if (session.ws) {
    try {
      session.ws.close();
    } catch {}
    session.ws = null;
  }
  // Neutralize any onExit closure captured at spawn time. Fast Refresh does
  // not re-wire child.onExit, so a tile created before the current module
  // revision still runs the OLD handler — which has no `destroyed` check and
  // would auto-restart the session the user just closed. Nulling the claude
  // id drops that stale closure into its harmless "no claude id" branch.
  // Must come after the byClaudeId delete above, which needs the id.
  session.claudeSessionId = null;
  persistSessions(state);
}

// Wires {input,resize,kill,close} handlers between a WebSocket and an
// existing Session. Used for both initial spawn and reattach.
function attachWsHandlers(
  state: PtyServerState,
  session: Session,
  ws: WebSocket,
) {
  ws.on("message", (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch (e) {
      console.error(
        `[pty-server] parse error for ${session.key}:`,
        (e as Error).message,
        "raw:",
        raw.toString("utf8").slice(0, 200),
      );
      return;
    }
    const t = msg.type as string;
    if (t === "input" && typeof msg.data === "string") {
      const data = msg.data;
      // Log the hex of the bytes so we can see exactly what the PTY receives.
      const hex = Array.from(data)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(" ");
      console.log(
        `[pty-server] ${session.key} ← input ${data.length}B [${hex}] pid=${session.pty?.pid ?? session._orphanPid ?? "?"}`,
      );
      if (!session.pty) {
        console.warn(
          `[pty-server] ${session.key} has no PTY handle (re-adopted orphan), ignoring input`,
        );
        return;
      }
      try {
        session.pty.write(data);
      } catch (e) {
        console.error(
          `[pty-server] write failed for ${session.key}:`,
          (e as Error).message,
        );
      }
    } else if (
      t === "resize" &&
      typeof msg.cols === "number" &&
      typeof msg.rows === "number"
    ) {
      console.log(
        `[pty-server] ${session.key} ← resize ${msg.cols}x${msg.rows}`,
      );
      if (session.pty) {
        try {
          session.pty.resize(msg.cols as number, msg.rows as number);
          resizeVt(session, msg.cols as number, msg.rows as number);
        } catch (e) {
          console.error(`[pty-server] resize failed:`, (e as Error).message);
        }
      }
    } else if (t === "kill") {
      // Explicit close from the user (× close session button). Tear it down.
      destroySession(state, session, "client:kill");
    } else {
      console.warn(`[pty-server] ${session.key} unknown message type: ${t}`);
    }
  });

  ws.on("close", () => {
    // Guard against close events from a stale ws after we've already
    // reattached a fresh one.
    if (session.ws !== ws) return;
    // The user navigated away (back to mission control, closed tab, etc.).
    // Do NOT kill the PTY. The session stays alive indefinitely until the
    // user explicitly closes it. Reattach picks up where we left off.
    console.log(
      `[pty-server] ${session.key} ws detached → keeping pty alive pid=${session.pty?.pid ?? session._orphanPid ?? "?"}`,
    );
    session.ws = null;
    // No reap timer — session stays alive indefinitely until the user
    // explicitly closes it. The PTY keeps running in the background.
  });
}

async function handleConnection(
  ws: WebSocket,
  req: { url?: string },
): Promise<void> {
  const state = g[KEY]!;
  const url = req.url ?? "/pty";
  const {
    session: requestedId,
    mode,
    flavor: urlFlavor,
    cols: initialCols,
    rows: initialRows,
  } = parseUrl(url);
  // Safety net: a resume link that lost its ?flavor= would spawn a claude2
  // session under the DEFAULT ~/.claude config — wrong Anthropic account,
  // wrong cwd, and the transcript isn't even there ("No conversation found
  // with session ID"). The JSONL location is the source of truth, so if the
  // id lives under ~/.claude-alt, force claude2 no matter what the URL said.
  const flavor: "claude" | "claude2" =
    urlFlavor === "claude" && mode === "resume" && requestedId &&
    findJsonlForSession(requestedId)?.includes(`${path.sep}.claude-alt${path.sep}`)
      ? "claude2"
      : urlFlavor;

  // ── Reattach path ─────────────────────────────────────────────────
  // If the request names an existing in-memory session by claude UUID,
  // reattach the new WebSocket to its PTY instead of spawning a new
  // claude. This is the "I went back to MC and clicked the tile" flow.
  if (mode === "resume" && requestedId) {
    const existing = state.byClaudeId.get(requestedId);
    if (existing && !existing.ptyExited) {
      console.log(
        `[pty-server] reattaching ws to ${existing.key} pid=${existing.pty.pid}`,
      );
      // Cancel the reaper.
      if (existing.reapTimer) {
        clearTimeout(existing.reapTimer);
        existing.reapTimer = null;
      }
      // If a stale ws is somehow still attached, close it. Its old close
      // handler is a no-op now thanks to the `session.ws !== ws` guard.
      const oldWs = existing.ws;
      existing.ws = null;
      if (oldWs) {
        try {
          oldWs.close();
        } catch {}
      }
      // Match the PTY to the grid of the client that's attaching now. The
      // buffer below was produced at whatever size the PREVIOUS client had;
      // replaying it into a different grid leaves Claude's full-screen frames
      // wrapped against the wrong column count, which renders as a console
      // full of left-truncated lines and text flung off to the right.
      const sizeChanged =
        existing.pty.cols !== initialCols || existing.pty.rows !== initialRows;
      if (sizeChanged) {
        try {
          existing.pty.resize(initialCols, initialRows);
          resizeVt(existing, initialCols, initialRows);
        } catch {}
      }

      // Sessions spawned before the headless terminal existed have no vt and
      // their onData handler is the old one. Attach a second listener that
      // starts a vt at the next full-screen clear (the redraw nudge below
      // triggers one), so the NEXT reattach gets the clean snapshot path.
      if (existing.vt === undefined && existing.pty) {
        const cols = existing.pty.cols || initialCols;
        const rows = existing.pty.rows || initialRows;
        const term = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
        const ser = new SerializeAddon();
        term.loadAddon(ser as never);
        existing.vt = { term, ser, complete: false };
        console.log(`[pty-server] ${existing.key} screen copy armed (starts at next full redraw)`);
        existing.pty.onData((d: string) => {
          const v = existing.vt;
          if (!v) return;
          if (!v.complete) {
            const i = Math.max(d.lastIndexOf("\x1b[2J"), d.lastIndexOf("\x1b[3J"));
            if (i === -1) return;
            v.term.reset();
            v.term.write(d.slice(i));
            v.complete = true;
            return;
          }
          v.term.write(d);
        });
      }

      // Preferred path: send the headless terminal's exact screen. Wait for it
      // to finish parsing everything written so far (write("") calls back in
      // order), holding new live chunks in attachPending meanwhile.
      const vt = existing.vt;
      if (vt && vt.complete) {
        existing.attachPending = [];
        vt.term.write("", () => {
          const pending = existing.attachPending ?? [];
          existing.attachPending = null;
          if (ws.readyState !== 1 /* OPEN */ || existing.ptyExited) return;
          let snap = "";
          try {
            snap = vt.ser.serialize({ scrollback: 3000 });
          } catch {}
          console.log(`[pty-server] ${existing.key} reattach via screen snapshot (${snap.length}B, ${pending.length} pending)`);
          safeSend(ws, { type: "session", id: existing.claudeSessionId! });
          if (snap.length > 0) safeSend(ws, { type: "data", data: snap });
          for (const d of pending) safeSend(ws, { type: "data", data: d });
          existing.ws = ws;
          attachWsHandlers(state, existing, ws);
          setTimeout(() => {
            if (existing.ws !== ws || existing.ptyExited) return;
            try {
              existing.pty.resize(Math.max(2, initialCols - 1), initialRows);
              existing.pty.resize(initialCols, initialRows);
            } catch {}
          }, 120);
        });
        return;
      }

      // SYNC BLOCK START — no awaits between here and `existing.ws = ws`
      // so child.onData callbacks can't interleave: the snapshot we send
      // and the next live chunk go out in the right order.
      // Drop replay bytes the PTY itself already erased. ESC[2J / ESC[3J
      // clear the whole screen, so anything written before the LAST one was
      // not on screen when the previous client left; replaying it only
      // smears stale frames under the real one. Everything else is genuine
      // scrollback and survives. Inlined deliberately — a top-level helper
      // here goes missing under Next's server hot-reload.
      const rawBuf = existing.buffer;
      const clearAt = Math.max(
        rawBuf.lastIndexOf("\x1b[2J"),
        rawBuf.lastIndexOf("\x1b[3J"),
      );
      const snapshot = clearAt === -1 ? rawBuf : rawBuf.slice(clearAt);
      safeSend(ws, { type: "session", id: existing.claudeSessionId! });
      if (snapshot.length > 0) {
        safeSend(ws, { type: "data", data: snapshot });
      }
      existing.ws = ws;
      // SYNC BLOCK END
      attachWsHandlers(state, existing, ws);
      // Nudge the TUI into repainting a clean frame on top of the replay.
      // A one-column jiggle makes Claude Code redraw from scratch at the
      // real size, which overwrites anything the stale replay smeared.
      setTimeout(() => {
        if (existing.ws !== ws || existing.ptyExited) return;
        try {
          existing.pty.resize(Math.max(2, initialCols - 1), initialRows);
          existing.pty.resize(initialCols, initialRows);
        } catch {}
      }, 120);
      return;
    }
    // If the session exists but its PTY has exited (crash, OOM, etc.) or
    // it's a re-adopted orphan with no PTY handle, cancel the grace timer
    // and clean up the stale entry now — the fresh spawn below will
    // re-register under the same claude id.
    if (existing && existing.ptyExited) {
      console.log(
        `[pty-server] ${existing.key} PTY is dead, clearing stale entry and spawning fresh`,
      );
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      state.sessions.delete(existing.key);
      if (existing.claudeSessionId) {
        state.byClaudeId.delete(existing.claudeSessionId);
      }
      persistSessions(state);
    }
  }

  // ── Fresh spawn path ──────────────────────────────────────────────
  // Lazy import so that Next.js can tree-shake native module on the client.
  const pty = (await import("node-pty")) as typeof import("node-pty");

  const claudeArgs: string[] = [...CLAUDE_LAUNCHER.baseArgs];
  if (mode === "resume" && requestedId) {
    claudeArgs.push("--resume", requestedId);
  }
  // The "claude2" flavor mirrors the user's shell alias:
  //   cd ~/yscapp && CLAUDE_CONFIG_DIR=~/.claude-alt claude --dangerously-skip-permissions
  // It runs against a separate ~/.claude-alt config dir (separate settings,
  // separate plan/usage), with cwd pinned to the yscapp project. The default
  // "claude" flavor leaves cwd and env untouched.
  const isClaude2 = flavor === "claude2";
  // Lockdown flag: when the user kills-all-claude2, we set a ban until timestamp
  // so reconnecting browser tabs can't immediately re-summon fresh yscapp claudes.
  const lockUntil = (g[KEY] as unknown as { claude2LockUntil?: number })
    ?.claude2LockUntil;
  if (isClaude2 && lockUntil && Date.now() < lockUntil) {
    console.log(
      `[pty-server] refusing claude2 spawn — locked until ${new Date(lockUntil).toISOString()}`,
    );
    safeSend(ws, {
      type: "error",
      message: "claude2 spawns are locked — close this tab",
    });
    try {
      ws.close();
    } catch {}
    return;
  }
  if (isClaude2 && !claudeArgs.includes("--dangerously-skip-permissions")) {
    claudeArgs.push("--dangerously-skip-permissions");
  }
  const spawnCwd = isClaude2
    ? path.join(os.homedir(), "yscapp")
    : os.homedir();
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Guarantee the child has the node-global bin dir on PATH so
    // subprocesses claude spawns (git, rg, etc.) also resolve cleanly.
    PATH: `${path.join(os.homedir(), ".npm-global", "bin")}:${path.join(os.homedir(), "bin")}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  };
  if (isClaude2) {
    spawnEnv.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude-alt");
  }

  let child: IPty;
  try {
    child = pty.spawn(CLAUDE_LAUNCHER.cmd, claudeArgs, {
      name: "xterm-256color",
      cols: initialCols,
      rows: initialRows,
      cwd: spawnCwd,
      env: spawnEnv,
    });
    console.log(
      `[pty-server] spawned pid=${child.pid} at ${child.cols}x${child.rows} (client asked ${initialCols}x${initialRows})`,
    );
  } catch (err) {
    // "posix_spawnp failed" has two very different causes that look
    // identical: a broken claude binary, or an exhausted pty table. Count
    // our own leaked master fds so the log says which one it is instead of
    // sending us back to reinstalling claude for the third time.
    let ptyHint = "";
    try {
      const leaked = fs
        .readdirSync(`/dev/fd`)
        .length;
      ptyHint =
        ` — this process holds ~${leaked} fds; macOS caps ptys at kern.tty.ptmx_max` +
        ` (511 by default), so if claude runs fine from a shell the pty table is` +
        ` full and Mission Control needs a restart to release them`;
    } catch {}
    console.error("[pty-server] spawn failed:", err, ptyHint);
    safeSend(ws, {
      type: "error",
      message: `spawn failed: ${(err as Error).message} (${CLAUDE_LAUNCHER.cmd} ${claudeArgs.join(" ")})${ptyHint}`,
    });
    try {
      ws.close();
    } catch {}
    return;
  }

  // For resume mode we already know the claude session id (it's the URL
  // param). For new mode we discover it later via pidfile polling.
  const initialClaudeId =
    requestedId && mode === "resume" ? requestedId : null;
  const initialKey = initialClaudeId ?? `new-${child.pid}`;
  console.log(
    `[pty-server] spawned ${initialKey} pid=${child.pid} via ${CLAUDE_LAUNCHER.cmd} ${claudeArgs.join(" ")}`,
  );

  const session: Session = {
    key: initialKey,
    pty: child,
    ws,
    startedAt: Date.now(),
    lastSpawnAt: Date.now(),
    claudeSessionId: initialClaudeId,
    buffer: "",
    reapTimer: null,
    pollTimer: null,
    ptyExited: false,
    graceTimer: null,
    flavor: isClaude2 ? "claude2" : "claude",
  };
  state.sessions.set(session.key, session);
  if (session.claudeSessionId) {
    state.byClaudeId.set(session.claudeSessionId, session);
    // Tell the client right away so its URL is canonical.
    safeSend(ws, { type: "session", id: session.claudeSessionId });
  }
  persistSessions(state);

  child.onData((data: string) => {
    // Always buffer (so we can replay on reattach) but only send to the
    // wire if a client is actually attached. While detached, the buffer
    // accumulates and the user picks up where they left off on reconnect.
    emitData(session, data);
  });

  const onPtyExit = async ({ exitCode }: { exitCode: number }) => {
    const exitedPid = session.pty?.pid;
    console.log(
      `[pty-server] ${session.key} pty exited code=${exitCode} pid=${exitedPid}`,
    );
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = null;
    }

    // Auto-restart: if the session has a claude ID (resumable), ALWAYS
    // respawn it regardless of exit code. Sessions should never disappear
    // unless the user explicitly killed them. Retry indefinitely with
    // exponential-ish backoff so transient failures (system under load,
    // filesystem hiccups) don't turn into permanent ghost sessions.
    // Honor the flavor lockdown: if the user called killAllByFlavor for
    // this flavor, don't auto-restart. Without this check a stale orphan
    // closure will keep respawning claudes even after the user asked to
    // close them all.
    // The user closed this one on purpose. Stay dead.
    if (session.destroyed) {
      console.log(
        `[pty-server] ${session.key} auto-restart SKIPPED — destroyed on purpose`,
      );
      session.ptyExited = true;
      return;
    }

    const lockU = (g[KEY] as unknown as { claude2LockUntil?: number })
      ?.claude2LockUntil;
    if (
      session.flavor === "claude2" &&
      lockU &&
      Date.now() < lockU
    ) {
      console.log(
        `[pty-server] ${session.key} auto-restart SKIPPED — claude2 locked`,
      );
      session.claudeSessionId = null;
      session.ptyExited = true;
      return;
    }
    const claudeId = session.claudeSessionId;
    if (claudeId) {
      // `claude --resume <id>` needs a transcript on disk. Without one it
      // prints "No conversation found with session ID" and exits 1 — every
      // time, forever. Restarting that is a hot loop, not resilience.
      if (!findJsonlForSession(claudeId)) {
        console.log(
          `[pty-server] ${session.key} auto-restart SKIPPED — no transcript on disk for ${claudeId}, --resume can never succeed`,
        );
        session.ptyExited = true;
        state.sessions.delete(session.key);
        state.byClaudeId.delete(claudeId);
        persistSessions(state);
        return;
      }

      // Crash-loop breaker. If the last respawn died almost immediately,
      // this is a permanent failure wearing a transient failure's clothes.
      const livedMs = Date.now() - (session.lastSpawnAt ?? session.startedAt);
      if (livedMs < 10_000) {
        session.rapidRestarts = (session.rapidRestarts ?? 0) + 1;
      } else {
        session.rapidRestarts = 0;
      }
      if ((session.rapidRestarts ?? 0) > 5) {
        console.log(
          `[pty-server] ${session.key} auto-restart GIVING UP — died within ${livedMs}ms on ${session.rapidRestarts} consecutive restarts`,
        );
        session.ptyExited = true;
        state.sessions.delete(session.key);
        state.byClaudeId.delete(claudeId);
        persistSessions(state);
        return;
      }

      const delays = [2_000, 5_000, 15_000, 30_000, 60_000];
      // Cap restarts. The previous `while (true)` ran up to 451 attempts
      // against a permanent `posix_spawnp failed`, pinning the event loop
      // and bloating stderr logs.
      const MAX_ATTEMPTS = 10;
      let attempt = 0;
      // Preserve the original spawn flavor so auto-restart keeps the right
      // cwd + CLAUDE_CONFIG_DIR. Otherwise a claude2 session would be
      // respawned as regular claude and --resume would fail.
      const wasClaude2 = session.flavor === "claude2";
      while (attempt < MAX_ATTEMPTS) {
        attempt += 1;
        console.log(
          `[pty-server] ${session.key} auto-restarting with --resume ${claudeId} (attempt ${attempt}, flavor=${session.flavor ?? "claude"})`,
        );
        try {
          const ptyMod = (await import("node-pty")) as typeof import("node-pty");
          const newArgs = [...CLAUDE_LAUNCHER.baseArgs, "--resume", claudeId];
          if (wasClaude2 && !newArgs.includes("--dangerously-skip-permissions")) {
            newArgs.push("--dangerously-skip-permissions");
          }
          const restartCwd = wasClaude2
            ? path.join(os.homedir(), "yscapp")
            : os.homedir();
          const restartEnv: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: `${path.join(os.homedir(), ".npm-global", "bin")}:${path.join(os.homedir(), "bin")}:${process.env.PATH ?? ""}`,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            FORCE_COLOR: "3",
          };
          if (wasClaude2) {
            restartEnv.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude-alt");
          }
          const newChild = ptyMod.spawn(CLAUDE_LAUNCHER.cmd, newArgs, {
            name: "xterm-256color",
            cols: child.cols ?? 120,
            rows: child.rows ?? 32,
            cwd: restartCwd,
            env: restartEnv,
          });
          // Release the OLD pty's master fd before dropping the reference.
          // node-pty's destroy() is implemented on UnixTerminal but is NOT
          // declared on IPty, so it has to be reached through a cast — which
          // is exactly why this was never called. Without it every respawn
          // orphans a UnixTerminal whose master fd stays open: macOS caps
          // ptys at kern.tty.ptmx_max (511), so a few hundred leaked ones
          // exhaust the table and EVERY new pty on the machine fails with
          // "posix_spawnp failed" — which looks like a broken claude binary.
          try {
            (child as unknown as { destroy?: () => void }).destroy?.();
          } catch {}
          session.pty = newChild;
          session.lastSpawnAt = Date.now();
          session.ptyExited = false;
          session.buffer = "";
          resetVt(session);
          session._orphanPid = undefined;
          persistSessions(state);
          newChild.onData((data: string) => {
            emitData(session, data);
          });
          // Re-wire the same exit handler on the new child so this loop
          // continues to cover future crashes.
          newChild.onExit(onPtyExit);
          console.log(
            `[pty-server] ${session.key} restarted as pid=${newChild.pid}`,
          );
          // `claude --resume <id>` writes a BRAND-NEW sessionId to its
          // pidfile and starts a new JSONL. Without aliasing, MC's file
          // watcher treats that as a separate session and the hub grid
          // sprouts a duplicate tile next to the real one. Poll the new
          // pidfile briefly and register the alias so the new JSONL
          // lands on the existing tile. Fire-and-forget — failure just
          // means the duplicate-tile-on-crash bug resurfaces, it won't
          // corrupt anything.
          const originalId = claudeId;
          const newPid = newChild.pid;
          void (async () => {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
              const newId = readClaudePidFile(newPid);
              if (newId) {
                if (newId !== originalId) {
                  registerAlias(newId, originalId);
                  console.log(
                    `[pty-server] auto-restart aliased ${newId} -> ${originalId} (pid=${newPid})`,
                  );
                }
                return;
              }
              await new Promise((r) => setTimeout(r, 200));
            }
            console.warn(
              `[pty-server] auto-restart: no pidfile for pid=${newPid} within 10s — new JSONL may spawn phantom tile`,
            );
          })();
          return;
        } catch (err) {
          console.error(
            `[pty-server] auto-restart attempt ${attempt} failed:`,
            err,
          );
          const delay = delays[Math.min(attempt - 1, delays.length - 1)];
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      console.error(
        `[pty-server] ${session.key} auto-restart GIVING UP after ${attempt} attempts`,
      );
    }

    // No claude id, or we exhausted restart attempts. Mark exited but keep
    // in memory so the tile still shows the last buffer — that comes from
    // session.buffer (a string), so the pty itself can go. Release its fd.
    try {
      (session.pty as unknown as { destroy?: () => void }).destroy?.();
    } catch {}
    session.ptyExited = true;
    safeSend(session.ws, { type: "exit", code: exitCode });
    if (session.ws) {
      try {
        session.ws.close();
      } catch {}
      session.ws = null;
    }
    persistSessions(state);
  };
  child.onExit(onPtyExit);

  startSessionIdPoll(state, session);
  attachWsHandlers(state, session, ws);
}

// Re-bind the live handleConnection pointer on every module evaluation.
// Next.js dev mode hot-reloads this file when it changes, but the wss
// (set up once at first startup) keeps its old "connection" listener
// closure. By dispatching through g[KEY].handleConnection inside that
// listener and overwriting the pointer here on each reload, edits to the
// spawn logic take effect without a server restart.
g[KEY]!.handleConnection = handleConnection;

export async function startPtyServer(): Promise<number> {
  const state = g[KEY]!;
  if (state.started && state.wss) return state.port;
  state.started = true;

  // ── Re-adopt persisted sessions ─────────────────────────────────
  // On startup, read the persistence file and re-adopt any sessions
  // whose Claude processes are still alive. These get placeholder
  // entries (no PTY handle, ptyExited=true) so getHubOwnedSessionIds()
  // includes them and the hub tile shows up. When a client clicks the
  // tile and connects with mode=resume, the ptyExited check causes it
  // to fall through to a fresh `claude --resume` spawn.
  const persisted = loadPersistedSessions();
  let adopted = 0;
  let respawned = 0;
  for (const p of persisted) {
    // Skip if we already have this session in memory (shouldn't happen
    // on a clean restart, but guard against double-init).
    if (state.byClaudeId.has(p.claudeSessionId)) continue;

    if (isPidAlive(p.pid)) {
      console.log(
        `[pty-server] re-adopting persisted session ${p.claudeSessionId} pid=${p.pid}`,
      );
      // PID still alive — create a ghost session. When a client clicks
      // the tile, the reattach path falls through to a fresh `claude
      // --resume` spawn (since ptyExited=true here).
      const ghost: Session = {
        key: p.key,
        pty: null as unknown as IPty,
        ws: null,
        startedAt: p.startedAt,
        claudeSessionId: p.claudeSessionId,
        buffer: "",
        reapTimer: null,
        pollTimer: null,
        ptyExited: true,
        graceTimer: null,
        _orphanPid: p.pid,
        flavor: p.flavor ?? "claude",
      };
      state.sessions.set(ghost.key, ghost);
      state.byClaudeId.set(p.claudeSessionId, ghost);
      adopted++;
      continue;
    }

    // PID is dead — dev server restart / mac sleep / OOM killed the
    // original process. Respawn a fresh `claude --resume <id>` headless
    // (no websocket) so the tile comes back with full context. The user
    // previously lost hours of conversation when these got silently
    // skipped.
    console.log(
      `[pty-server] persisted session ${p.claudeSessionId} pid=${p.pid} dead — respawning`,
    );
    try {
      // Use dynamic-require path so first startup doesn't force the
      // module to load before we actually need it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ptyMod = require("node-pty") as typeof import("node-pty");
      const isClaude2 = p.flavor === "claude2";
      const reArgs = [...CLAUDE_LAUNCHER.baseArgs, "--resume", p.claudeSessionId];
      if (isClaude2 && !reArgs.includes("--dangerously-skip-permissions")) {
        reArgs.push("--dangerously-skip-permissions");
      }
      const reCwd = isClaude2
        ? path.join(os.homedir(), "yscapp")
        : os.homedir();
      const reEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${path.join(os.homedir(), ".npm-global", "bin")}:${path.join(os.homedir(), "bin")}:${process.env.PATH ?? ""}`,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      };
      if (isClaude2) {
        reEnv.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude-alt");
      }
      const reChild = ptyMod.spawn(CLAUDE_LAUNCHER.cmd, reArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: reCwd,
        env: reEnv,
      });
      const reborn: Session = {
        key: p.key,
        pty: reChild,
        ws: null,
        startedAt: Date.now(),
        lastSpawnAt: Date.now(),
        claudeSessionId: p.claudeSessionId,
        buffer: "",
        reapTimer: null,
        pollTimer: null,
        ptyExited: false,
        graceTimer: null,
        flavor: p.flavor ?? "claude",
      };
      state.sessions.set(reborn.key, reborn);
      state.byClaudeId.set(p.claudeSessionId, reborn);
      reChild.onData((data: string) => {
        emitData(reborn, data);
      });
      // Wire the same auto-restart-on-exit behavior so crashes after
      // respawn still get healed.
      const rebornOnExit = async ({ exitCode }: { exitCode: number }) => {
        console.log(
          `[pty-server] ${reborn.key} pty exited code=${exitCode} pid=${reChild.pid} — re-triggering resume spawn`,
        );
        reborn.ptyExited = true;
        // Reuse the main onExit flow by recursing through the persistence
        // path — simplest way to keep the retry loop consistent.
        state.sessions.delete(reborn.key);
        state.byClaudeId.delete(reborn.claudeSessionId!);
        persistSessionsNow(state);
      };
      reChild.onExit(rebornOnExit);
      respawned++;
      console.log(
        `[pty-server] respawned ${p.claudeSessionId} as pid=${reChild.pid} (flavor=${p.flavor ?? "claude"})`,
      );
    } catch (err) {
      console.error(
        `[pty-server] respawn failed for ${p.claudeSessionId}:`,
        (err as Error).message,
      );
    }
  }
  if (adopted > 0 || respawned > 0) {
    console.log(
      `[pty-server] startup: re-adopted=${adopted}, respawned=${respawned}`,
    );
    persistSessionsNow(state);
  }

  const WSMod = (await import("ws")) as typeof import("ws");

  try {
    const wss = new WSMod.WebSocketServer({ host: BIND, port: state.port });
    wss.on("connection", (ws: WebSocket, req: { url?: string }) => {
      // Dereference fresh on every connection so hot-reloaded edits to
      // handleConnection (and everything it calls — parseUrl, the spawn
      // block, etc.) actually run. Falls back to the closure-captured
      // version if somehow unset.
      const fn = g[KEY]?.handleConnection ?? handleConnection;
      void fn(ws, req);
    });
    wss.on("error", (err: Error) => {
      console.error("[pty-server]", err);
    });
    state.wss = wss;
    console.log(`[pty-server] listening on ws://${BIND}:${state.port}`);
  } catch (err) {
    state.started = false;
    console.error("[pty-server] failed to start:", err);
  }
  return state.port;
}

// Public: returns the set of claude session UUIDs currently held by
// pty-server. The hub uses this to tag tiles as "hub-owned" so it can
// route their click target to /live/<id> for reattach instead of
// /s/<id> for read-only — the latter is only safe when a Warp window
// (not us) holds the JSONL file open.
export function getHubOwnedSessionIds(): Set<string> {
  const state = g[KEY];
  if (!state) return new Set();
  return new Set(state.byClaudeId.keys());
}

// Poll the new child's pidfile for its fresh claude sessionId, then
// register it as an alias back to the original canonical id used by the
// Mission Control tile. The watcher in store.ts calls canonicalSessionId()
// on every JSONL ingest, so as long as this alias is in place before the
// first write to the new JSONL lands, events route to the same tile.
async function bootstrapAliasAfterReset(
  childPid: number,
  canonicalId: string,
): Promise<void> {
  const startedAt = Date.now();
  const tick = async (): Promise<void> => {
    if (Date.now() - startedAt > SESSION_ID_POLL_TIMEOUT_MS) {
      console.warn(
        `[pty-server] reset bootstrap timed out: no pidfile for pid=${childPid}`,
      );
      return;
    }
    const newId = readClaudePidFile(childPid);
    if (!newId) {
      await new Promise((r) => setTimeout(r, SESSION_ID_POLL_MS));
      return tick();
    }
    if (newId === canonicalId) {
      // Unlikely but possible — claude reused the id. Nothing to alias.
      console.log(
        `[pty-server] reset bootstrap: new pidfile sessionId matches canonical (${canonicalId}), no alias needed`,
      );
      return;
    }
    registerAlias(newId, canonicalId);
    console.log(
      `[pty-server] reset bootstrap: aliased ${newId} → ${canonicalId} (pid=${childPid})`,
    );
  };
  // Give claude a moment to write its pidfile before the first check.
  await new Promise((r) => setTimeout(r, 200));
  await tick();
}

// Read the tail of a session's JSONL and return a compact primer the user
// can paste into the freshly-restarted claude to carry prior context over.
// We keep only user/assistant text turns (no tool_use/tool_result noise)
// and cap output size so the primer stays under ~4K chars.
function findJsonlForSession(sessionId: string): string | null {
  const roots = [
    path.join(os.homedir(), ".claude", "projects"),
    path.join(os.homedir(), ".claude-alt", "projects"),
  ];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const candidate = path.join(root, d, `${sessionId}.jsonl`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this dir
      }
    }
  }
  return null;
}

type PrimerTurn = { role: "me" | "claude"; text: string };

function extractTextFromContent(content: unknown): string {
  // Claude Code JSONL entries store message.content either as a string
  // (user text input) or as an array of content blocks (assistant output).
  // We only care about plain text; tool_use and tool_result blocks are
  // skipped.
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

export function buildResetPrimer(sessionId: string): string {
  const file = findJsonlForSession(sessionId);
  if (!file) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n").filter(Boolean);
  const turns: PrimerTurn[] = [];
  for (const line of lines) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = evt.type as string | undefined;
    const message = evt.message as { content?: unknown } | undefined;
    if (!message) continue;
    if (type === "user") {
      const text = extractTextFromContent(message.content);
      // Skip synthetic "tool_result" wrappers that arrive as user turns
      // but contain only command output with no natural language.
      if (text) turns.push({ role: "me", text });
    } else if (type === "assistant") {
      const text = extractTextFromContent(message.content);
      if (text) turns.push({ role: "claude", text });
    }
  }
  if (turns.length === 0) return "";

  const MAX_TURNS = 12;
  const MAX_CHARS = 4_000;
  const PER_TURN_CHARS = 500;
  const recent = turns.slice(-MAX_TURNS);

  const header = "Context from the previous session (the conversation was reset; carrying over so you have a bit of background):\n";
  const body = recent
    .map((t) => {
      const trimmed =
        t.text.length > PER_TURN_CHARS
          ? t.text.slice(0, PER_TURN_CHARS) + "…"
          : t.text;
      return `[${t.role}] ${trimmed}`;
    })
    .join("\n\n");
  const footer = "\n\nContinuing from here.";
  let primer = header + body + footer;
  if (primer.length > MAX_CHARS) {
    // Drop oldest turns one at a time until we fit.
    const keep = [...recent];
    while (primer.length > MAX_CHARS && keep.length > 1) {
      keep.shift();
      const body2 = keep
        .map((t) => {
          const trimmed =
            t.text.length > PER_TURN_CHARS
              ? t.text.slice(0, PER_TURN_CHARS) + "…"
              : t.text;
          return `[${t.role}] ${trimmed}`;
        })
        .join("\n\n");
      primer = header + body2 + footer;
    }
  }
  return primer;
}

// Public: called by POST /api/pty-reset. Kills the current claude child
// and respawns a fresh one IN PLACE (same session slot, same tile).
//
// Self-contained: does the kill + respawn directly rather than relying on
// child.onExit(onPtyExit). The existing onExit closure on the child was
// captured at original spawn time — Next's Fast Refresh does NOT re-wire
// it when pty-server.ts hot-reloads, so any logic added to onPtyExit
// wouldn't run for pre-existing tiles. Neutralizing the stale closure by
// nulling claudeSessionId makes its "no claude id" branch a harmless no-op.
export function resetSession(
  sessionId: string,
): { ok: true; primer: string } | { ok: false; error: string } {
  const state = g[KEY];
  if (!state) return { ok: false, error: "pty server not initialized" };
  const session = state.byClaudeId.get(sessionId);
  if (!session) {
    return { ok: false, error: "session not hub-owned" };
  }
  if (session.ptyExited || !session.pty) {
    return { ok: false, error: "session not running" };
  }
  const primer = buildResetPrimer(sessionId);
  const canonicalId = session.claudeSessionId!;
  const oldChild = session.pty;
  const wasClaude2 = session.flavor === "claude2";
  const savedCols = oldChild.cols ?? 120;
  const savedRows = oldChild.rows ?? 32;

  console.log(
    `[pty-server] ${sessionId} reset requested (primer ${primer.length} chars)`,
  );

  // Neutralize any stale onExit closure: when the old child dies, that
  // closure reads session.claudeSessionId. A null value sends it down the
  // "no claude id" branch which only marks ptyExited=true — harmless; we
  // overwrite that below when the fresh spawn is ready.
  session.claudeSessionId = null;

  void (async () => {
    // Listen for the exit ourselves. Multiple node-pty onExit listeners
    // are allowed — the stale closure and ours both fire, they don't
    // conflict since we neutralized the stale one above.
    const exited = new Promise<void>((resolve) => {
      try {
        oldChild.onExit(() => resolve());
      } catch {
        resolve();
      }
    });

    try {
      oldChild.kill("SIGTERM");
    } catch (err) {
      console.error(
        `[pty-server] ${sessionId} SIGTERM failed:`,
        (err as Error).message,
      );
    }
    const kill9 = setTimeout(() => {
      try {
        oldChild.kill("SIGKILL");
      } catch {}
    }, 1_500);
    await exited;
    clearTimeout(kill9);

    // Spawn fresh claude (no --resume) in the same session slot.
    try {
      const ptyMod = (await import("node-pty")) as typeof import("node-pty");
      const args = [...CLAUDE_LAUNCHER.baseArgs];
      if (wasClaude2 && !args.includes("--dangerously-skip-permissions")) {
        args.push("--dangerously-skip-permissions");
      }
      const cwd = wasClaude2
        ? path.join(os.homedir(), "yscapp")
        : os.homedir();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${path.join(os.homedir(), ".npm-global", "bin")}:${path.join(os.homedir(), "bin")}:${process.env.PATH ?? ""}`,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "3",
      };
      if (wasClaude2) {
        env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude-alt");
      }
      const newChild = ptyMod.spawn(CLAUDE_LAUNCHER.cmd, args, {
        name: "xterm-256color",
        cols: savedCols,
        rows: savedRows,
        cwd,
        env,
      });

      // Same fd release as the auto-restart path — see the note there.
      try {
        (oldChild as unknown as { destroy?: () => void }).destroy?.();
      } catch {}
      session.pty = newChild;
      session.lastSpawnAt = Date.now();
      session.ptyExited = false;
      session.buffer = "";
          resetVt(session);
      session._orphanPid = undefined;
      // Restore canonical id so writes (writeToSession) keep routing and
      // the tile stays keyed correctly.
      session.claudeSessionId = canonicalId;
      persistSessions(state);

      newChild.onData((data: string) => {
        emitData(session, data);
      });

      // Wire a simple auto-restart-on-crash handler for the new child.
      // If fresh claude itself crashes, resume its new internal id (which
      // we'll know once bootstrapAliasAfterReset learns it from the pidfile).
      newChild.onExit(async ({ exitCode }: { exitCode: number }) => {
        console.log(
          `[pty-server] ${canonicalId} post-reset pty exited code=${exitCode} pid=${newChild.pid}`,
        );
        session.ptyExited = true;
        // A subsequent reset (or a normal crash) will go through the
        // regular /api/pty-reset or websocket-reattach paths. We don't
        // auto-restart here — the user-visible tile already has the new
        // buffer, and they can click ↻ again if needed.
      });

      console.log(
        `[pty-server] ${canonicalId} reset spawned fresh claude pid=${newChild.pid}`,
      );
      void bootstrapAliasAfterReset(newChild.pid, canonicalId);
    } catch (err) {
      console.error(
        `[pty-server] ${canonicalId} reset spawn failed:`,
        (err as Error).message,
      );
      // Leave session.claudeSessionId null and ptyExited as whatever the
      // stale closure left it. The tile will fall over to the re-spawn
      // path on next client reattach.
    }
  })();

  return { ok: true, primer };
}

// Public: called by POST /api/pty-kill. Permanently terminates a hub-owned
// session — kills the claude child and prevents the stale onPtyExit closure
// from auto-restarting it. Same neutralization trick as resetSession:
// nulling claudeSessionId makes the restart branch a no-op since it reads
// the field at exit time. Also removes the session from state + persist so
// it doesn't come back on dev-server restart.
//
// Matches by claude UUID first, then by internal key (for freshly-spawned
// sessions that haven't learned their UUID yet — those are keyed as
// `new-${pid}` in state.sessions).
export function killSession(
  sessionId: string,
): { ok: true } | { ok: false; error: string } {
  const state = g[KEY];
  if (!state) return { ok: false, error: "pty server not initialized" };
  let session = state.byClaudeId.get(sessionId);
  if (!session) session = state.sessions.get(sessionId);
  if (!session) return { ok: false, error: "session not hub-owned" };
  console.log(
    `[pty-server] ${sessionId} kill requested (pid=${session.pty?.pid ?? session._orphanPid ?? "?"})`,
  );
  session.claudeSessionId = null;
  destroySession(state, session, "client:kill-endpoint");
  return { ok: true };
}

// Public: kill every hub-owned session whose flavor matches. Used as a
// blast-radius "shut it all down" button for yscapp (claude2) when the
// individual kill button isn't reachable.
export function killAllByFlavor(
  flavor: "claude" | "claude2",
): { ok: true; killed: number } {
  const state = g[KEY];
  if (!state) return { ok: true, killed: 0 };
  const targets: Session[] = [];
  for (const s of state.sessions.values()) {
    if ((s.flavor ?? "claude") === flavor) targets.push(s);
  }
  for (const s of targets) {
    console.log(
      `[pty-server] killAllByFlavor(${flavor}) → ${s.key} pid=${s.pty?.pid ?? s._orphanPid ?? "?"}`,
    );
    s.claudeSessionId = null;
    destroySession(state, s, `client:kill-all-${flavor}`);
  }
  // Arm a 10-minute lockdown that refuses fresh spawns of this flavor. Gives
  // the user time to close stale browser tabs that would otherwise auto-
  // reconnect and respawn the claudes we just killed.
  if (flavor === "claude2") {
    (state as unknown as { claude2LockUntil: number }).claude2LockUntil =
      Date.now() + 10 * 60 * 1000;
  }
  return { ok: true, killed: targets.length };
}

// Public: clear the claude2 spawn lockdown. Call this before intentionally
// opening a new yscapp tile.
export function unlockFlavor(flavor: "claude" | "claude2"): { ok: true } {
  const state = g[KEY];
  if (!state) return { ok: true };
  if (flavor === "claude2") {
    (state as unknown as { claude2LockUntil?: number }).claude2LockUntil =
      undefined;
  }
  return { ok: true };
}

// Public: write raw bytes to a hub-owned PTY's stdin without holding a
// WebSocket open. Used by /api/pty-input so the hub tiles can send a
// message to claude with a single POST. Returns false if no such
// session is hub-owned.
// Plain text of the session's current screen (bottom `rows` lines), from the headless terminal.
// Used to see what was on screen when a typed message didn't get submitted.
export async function getScreenText(sessionId: string, rows = 40): Promise<string | null> {
  const session = g[KEY]?.byClaudeId.get(sessionId);
  if (!session) return null;
  let term = session.vt?.complete ? session.vt.term : null;
  if (!term) {
    // No trustworthy screen copy (session predates it): rebuild one from the replay buffer.
    // Replaying from the last clear-screen keeps the redraw cheap and the result exact.
    const raw = session.buffer;
    const clearAt = raw.lastIndexOf("\x1b[2J");
    term = new HeadlessTerminal({ cols: session.pty?.cols || 120, rows: session.pty?.rows || 32, scrollback: 0, allowProposedApi: true });
    term.write(clearAt === -1 ? raw : raw.slice(clearAt));
    await new Promise<void>((r) => term!.write("", r));
  }
  const buf = term.buffer.active;
  const end = buf.baseY + term.rows;
  const lines: string[] = [];
  for (let y = Math.max(0, end - rows); y < end; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  const text = lines.join("\n").replace(/\n+$/, "");
  if (!session.vt?.complete) term.dispose();
  return text || `[blank: rows=${term.rows} cols=${term.cols} buffer=${session.buffer.length}]`;
}

export function writeToSession(sessionId: string, data: string): boolean {
  const state = g[KEY];
  if (!state) return false;
  const session = state.byClaudeId.get(sessionId);
  if (!session || session.ptyExited) return false;
  try {
    session.pty.write(data);
    return true;
  } catch (e) {
    console.error(
      `[pty-server] writeToSession failed for ${sessionId}:`,
      (e as Error).message,
    );
    return false;
  }
}
