"use client";

// xterm.js wrapper that connects to the hub's node-pty WebSocket bridge.
// Minimal shell: just a fullscreen terminal. Parent exposes a close button.
//
// Reconnection: the WS auto-reconnects when it drops (browser throttling,
// network glitch, tab freeze). The server keeps the PTY alive for 30 min
// after disconnect, so reconnecting picks up exactly where we left off
// via the replay buffer. A visibilitychange listener also kicks a
// reconnect when the user returns to a previously-backgrounded tab.

import { useEffect, useRef, useState } from "react";

// Console typeface — macOS system mono, no CDN round-trip so it can never
// silently fall back. Keep in sync with tailwind.config.ts + globals.css.
const CONSOLE_FONT =
  'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Monaco, monospace';

type Mode = "new" | "resume";
type Flavor = "claude" | "claude2";

type Props = {
  sessionId: string;
  mode: Mode;
  flavor?: Flavor;
  className?: string;
  onExit?: (code: number) => void;
  /** Imperative handle: parent can call close() to kill the session cleanly. */
  closeRef?: React.MutableRefObject<(() => void) | null>;
};

type Msg =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | { type: "session"; id: string }
  | { type: "ready" };

// Grok-style dark theme: pure black, soft white text, standard bright ANSI
// colours. minimumContrastRatio (set on the Terminal) keeps dim truecolor
// text readable.
const WARP_THEME = {
  background: "#000000",
  foreground: "#ECECEC",
  cursor: "#ECECEC",
  cursorAccent: "#000000",
  selectionBackground: "rgba(255, 255, 255, 0.18)",
  black: "#262626",
  red: "#F87171",
  green: "#4ADE80",
  yellow: "#FBBF24",
  blue: "#60A5FA",
  magenta: "#C084FC",
  cyan: "#67E8F9",
  white: "#D4D4D4",
  brightBlack: "#737373",
  brightRed: "#FCA5A5",
  brightGreen: "#86EFAC",
  brightYellow: "#FDE68A",
  brightBlue: "#93C5FD",
  brightMagenta: "#D8B4FE",
  brightCyan: "#A5F3FC",
  brightWhite: "#FFFFFF",
};

export function InteractiveTerminal({
  sessionId,
  mode,
  flavor = "claude",
  className,
  onExit,
  closeRef,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);

  // Push-to-talk state: hold space inside the terminal to record audio in
  // the browser, send to /api/transcribe, then forward the text into the
  // PTY via the WS. Avoids depending on the spawned claude process having
  // macOS microphone access (which it doesn't, since the dev server is
  // typically orphaned from any terminal with TCC mic permission).
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pttTokenRef = useRef(0);
  const audioChunksRef = useRef<Blob[]>([]);
  const pttActiveRef = useRef(false);
  const [pttState, setPttState] = useState<"idle" | "recording" | "transcribing" | "error">("idle");
  const [pttError, setPttError] = useState<string | null>(null);
  // Stable refs to startPTT / stopPTTAndSend so the xterm key handler
  // (set up once) always calls the latest implementation.
  const startPTTRef = useRef<() => void>(() => {});
  const stopPTTRef = useRef<() => void>(() => {});

  // Track the resolved session id. On new sessions, the server discovers
  // the real claude UUID and sends it back — we need to use that for
  // reconnections, not the original "new" placeholder.
  const resolvedIdRef = useRef<string>(sessionId);
  // Tracks whether the user explicitly killed the session (× button).
  // Prevents reconnection after intentional close.
  const killedRef = useRef(false);
  // Tracks whether the PTY process exited. Prevents reconnect loops
  // when the session has genuinely ended.
  const exitedRef = useRef(false);
  // Reconnect timer handle for cleanup.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    let cleanupDom: (() => void) | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;

    // How many consecutive reconnect attempts have failed.
    let reconnectAttempts = 0;
    const FAST_RECONNECT_ATTEMPTS = 20;
    // Base delay between reconnect attempts (doubles each time, capped at 10s).
    const RECONNECT_BASE_MS = 500;
    const RECONNECT_MAX_MS = 10_000;
    // After fast attempts exhausted, retry every 30s indefinitely.
    const SLOW_RECONNECT_MS = 30_000;
    // Whether we've entered the slow-poll phase.
    let inSlowMode = false;

    const focusTerm = () => {
      try {
        const t = termRef.current;
        if (!t) return;
        t.focus();
        const helper = host.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | null;
        helper?.focus();
      } catch {}
    };

    // ── connectWs ──────────────────────────────────────────────────
    // Creates a WebSocket connection to the PTY bridge. Called on
    // initial mount and again on every reconnect. The xterm instance
    // lives for the full component lifetime — only the WS is recycled.
    function connectWs(term: import("@xterm/xterm").Terminal, isReconnect: boolean) {
      if (cancelled || killedRef.current || exitedRef.current) return;

      // Prevent concurrent WS connections — if one is already connecting
      // or open, bail. This guards against overlapping reconnect timers
      // or visibility-change races.
      const prev = wsRef.current;
      if (prev && (prev.readyState === WebSocket.CONNECTING || prev.readyState === WebSocket.OPEN)) {
        return;
      }

      // On reconnect, always use "resume" mode with the resolved id so
      // the server reattaches the existing PTY instead of spawning.
      const connMode = isReconnect ? "resume" : mode;
      const connId = isReconnect ? resolvedIdRef.current : sessionId;
      // Send the measured grid at connect time. Without this the server
      // spawns the PTY at a hardcoded default and Claude renders its first
      // frames against the wrong column count; the resize that follows on
      // "open" arrives too late to repair what is already drawn.
      const params = new URLSearchParams({
        session: connId,
        mode: connMode,
        flavor,
        cols: String(term.cols || 120),
        rows: String(term.rows || 32),
      });
      const wsUrl = `ws://${window.location.hostname}:4101/pty?${params.toString()}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (cancelled) {
          try { ws.close(); } catch {}
          return;
        }
        reconnectAttempts = 0; // success — reset backoff
        inSlowMode = false;
        try {
          // Re-measure only if the container actually has a size. A hidden
          // or mid-transition host measures as 0 and fit() would then lock
          // the grid to a nonsense value for the rest of the session.
          const h = hostRef.current;
          if (h && h.clientWidth > 0 && h.clientHeight > 0) fit?.fit();
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        } catch {}
        if (isReconnect) {
          // Reset hard before the replay. The server replays its buffer on
          // reattach, which repeats output we already rendered; reset() also
          // drops any half-consumed escape sequence left over from the
          // moment the socket died, which would otherwise swallow the first
          // bytes of the replay and shear the frame.
          //
          // Nothing is written here on purpose. Injecting even one line of
          // our own ("[reconnected]") pushes the TUI's frame down a row, and
          // every cursor-relative redraw Claude does afterwards then paints
          // one row off — which is what a visibly "bugged" console is. The
          // backoff path below stays silent for the same reason.
          term.reset();
        }
        focusTerm();
      });

      ws.addEventListener("message", (e: MessageEvent<string>) => {
        let msg: Msg;
        try {
          msg = JSON.parse(e.data) as Msg;
        } catch {
          return;
        }
        if (msg.type === "data") {
          term.write(msg.data);
        } else if (msg.type === "session") {
          if (msg.id) {
            resolvedIdRef.current = msg.id;
            try {
              window.history.replaceState({}, "", `/live/${msg.id}`);
            } catch {}
          }
        } else if (msg.type === "exit") {
          // If the user explicitly killed the session (× button), don't
          // restart. Otherwise auto-reconnect with `claude --resume` so
          // the console never disappears on the user.
          if (killedRef.current) {
            exitedRef.current = true;
            term.writeln(
              `\r\n\x1b[33m[session closed]\x1b[0m`,
            );
            onExit?.(msg.code);
          } else {
            term.writeln(
              `\r\n\x1b[33m[session exited — restarting…]\x1b[0m`,
            );
            // Close this WS cleanly, then reconnect after a beat.
            // The server will spawn a fresh `claude --resume <id>`.
            wsRef.current = null;
            try { ws.close(); } catch {}
            reconnectAttempts = 0;
            inSlowMode = false;
            setTimeout(() => {
              if (cancelled || killedRef.current) return;
              connectWs(term, true);
            }, 1500);
          }
        } else if (msg.type === "error") {
          term.writeln(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m`);
        }
      });

      ws.addEventListener("close", () => {
        if (cancelled || killedRef.current || exitedRef.current) return;
        // WS dropped unexpectedly while we're still mounted — reconnect.
        wsRef.current = null;
        scheduleReconnect(term);
      });

      ws.addEventListener("error", () => {
        // The close event fires after error, so reconnect is handled there.
      });
    }

    function scheduleReconnect(term: import("@xterm/xterm").Terminal) {
      if (cancelled || killedRef.current || exitedRef.current) return;

      let delay: number;

      if (reconnectAttempts < FAST_RECONNECT_ATTEMPTS) {
        // Fast phase: exponential backoff from 500ms up to 10s.
        delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
          RECONNECT_MAX_MS,
        );
        reconnectAttempts++;
        // Reconnect silently: writing a notice into the terminal corrupts the
        // running TUI's screen (Claude's input box), and reconnect is automatic.
      } else {
        // Slow phase: retry every 30s indefinitely. Never give up.
        delay = SLOW_RECONNECT_MS;
        reconnectAttempts++;
        inSlowMode = true;
      }

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectWs(term, true);
      }, delay);
    }

    (async () => {
      const xtermMod = await import("@xterm/xterm");
      const fitMod = await import("@xterm/addon-fit");
      const linksMod = await import("@xterm/addon-web-links");
      if (cancelled) return;

      // Wait for the webfonts before xterm measures a character cell.
      // Measuring against the fallback gives wrong cell dims and the grid
      // ends up misaligned once the real font swaps in.
      try {
        await document.fonts.ready;
      } catch {}
      if (cancelled) return;

      const term = new xtermMod.Terminal({
        fontFamily: CONSOLE_FONT,
        fontSize: 14.5,
        lineHeight: 1.5,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10_000,
        allowProposedApi: true,
        theme: WARP_THEME,
        minimumContrastRatio: 4.5,
        convertEol: false,
        macOptionIsMeta: true,
        // Don't snap the viewport to the bottom when the user (or our
        // PTT handler) hits a key. Reader-friendly: stay where the user
        // scrolled to. Without this, even a space sent through PTT would
        // briefly cause an internal scrollToBottom.
        scrollOnUserInput: false,
      });
      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      // URLs in session output become clickable and open in a new tab.
      term.loadAddon(
        new linksMod.WebLinksAddon((_event, uri) => {
          window.open(uri, "_blank", "noopener");
        }),
      );
      term.open(host);
      termRef.current = term;

      // Measure the cell grid only once the browser has actually laid the
      // host element out. fit() on the same tick as open() can read a
      // container that is still zero-width, which both sizes the PTY wrong
      // and makes every later resize fight the first bad measurement.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (cancelled) {
        try {
          term.dispose();
        } catch {}
        return;
      }
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {}
      }

      // Pipe xterm keystrokes → WebSocket → PTY
      term.onData((data: string) => {
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) {
          w.send(JSON.stringify({ type: "input", data }));
        }
      });

      // We deliberately do NOT install a customKeyEventHandler for
      // Space. The PTT trigger lives in a window-level capture-phase
      // keydown (see PTT useEffect below) which uses hold-detect: quick
      // taps go through as normal space characters; long holds switch
      // into voice recording. Both rely on xterm receiving keys
      // normally, plus `scrollOnUserInput: false` to keep the viewport
      // pinned wherever the user has scrolled.

      // Grab focus so first keystroke lands in the PTY. Refocus on any click.
      const onHostClick = () => focusTerm();
      host.addEventListener("mousedown", onHostClick);
      host.addEventListener("click", onHostClick);
      cleanupDom = () => {
        host.removeEventListener("mousedown", onHostClick);
        host.removeEventListener("click", onHostClick);
      };
      focusTerm();

      // Connect the WebSocket (initial connection)
      connectWs(term, false);

      // Expose imperative close() to the parent — sends {type:"kill"} so the
      // server starts SIGTERM/SIGKILL, then closes the socket. The PTY is
      // torn down whether or not the navigate-away cleanup races with us.
      if (closeRef) {
        closeRef.current = () => {
          killedRef.current = true;
          try {
            const w = wsRef.current;
            if (w && w.readyState === WebSocket.OPEN) {
              w.send(JSON.stringify({ type: "kill" }));
            }
          } catch {}
          setTimeout(() => {
            try {
              wsRef.current?.close();
            } catch {}
          }, 50);
        };
      }

      // Keep PTY sized to the container.
      //
      // Debounced and deduplicated on purpose. A drag, a tile animation or a
      // sidebar toggle fires this dozens of times a second; forwarding each
      // one SIGWINCHes the TUI mid-draw and leaves half-painted frames on
      // screen. We also skip zero-size observations — a hidden or
      // mid-transition container measures as 0 and fit() would compute a
      // nonsense grid from it.
      let lastCols = term.cols;
      let lastRows = term.rows;
      resizeObs = new ResizeObserver(() => {
        if (resizeDebounce !== null) clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
          resizeDebounce = null;
          if (cancelled) return;
          if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
          try {
            fit?.fit();
          } catch {
            return;
          }
          if (term.cols === lastCols && term.rows === lastRows) return;
          lastCols = term.cols;
          lastRows = term.rows;
          const w = wsRef.current;
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }
        }, 80);
      });
      resizeObs.observe(host);

      // When the tab becomes visible again, check if WS is still alive.
      // Browsers freeze background tabs which can silently kill the socket.
      const onVisChange = () => {
        if (document.visibilityState !== "visible") return;
        if (cancelled || killedRef.current || exitedRef.current) return;
        const w = wsRef.current;
        if (!w || w.readyState === WebSocket.CLOSED || w.readyState === WebSocket.CLOSING) {
          wsRef.current = null;
          // Cancel any in-flight backoff timer to prevent racing with
          // the fresh reconnect we're about to schedule.
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          // Reset backoff on visibility change — the user actively came back.
          // Switch back to fast mode so we get rapid reconnection.
          reconnectAttempts = 0;
          inSlowMode = false;
          scheduleReconnect(term);
        }
      };
      document.addEventListener("visibilitychange", onVisChange);
      const origCleanupDom = cleanupDom;
      cleanupDom = () => {
        origCleanupDom?.();
        document.removeEventListener("visibilitychange", onVisChange);
      };
    })();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try {
        resizeObs?.disconnect();
      } catch {}
      if (resizeDebounce !== null) {
        clearTimeout(resizeDebounce);
        resizeDebounce = null;
      }
      try {
        wsRef.current?.close();
      } catch {}
      try {
        cleanupDom?.();
      } catch {}
      try {
        termRef.current?.dispose();
      } catch {}
      termRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mode]);

  // ── Push-to-talk: hold space inside the terminal to record. ──────────
  // Mirror of the TerminalTile flow but adapted for xterm: when the
  // xterm-helper-textarea (or the host) has focus, intercept the Space
  // keydown in the capture phase, preventDefault so it never reaches the
  // PTY, start MediaRecorder, and on keyup POST the audio to
  // /api/transcribe and forward the resulting text into the PTY as if
  // the user typed it.
  useEffect(() => {
    const startPTT = async () => {
      if (pttActiveRef.current) return;
      pttActiveRef.current = true;
      setPttState("recording");
      setPttError(null);
      audioChunksRef.current = [];
      const token = ++pttTokenRef.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (token !== pttTokenRef.current || !pttActiveRef.current) {
          // Key released (or re-pressed) while the mic was still coming up.
          // Starting now would leave an orphan recorder running forever whose
          // chunks interleave with the next hold's — the corrupt-blob bug.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
        mr.start(250);
        recorderRef.current = mr;
      } catch {
        pttActiveRef.current = false;
        setPttError("Mic blocked — check browser permissions");
        setPttState("error");
        setTimeout(() => setPttState("idle"), 3000);
      }
    };

    const stopPTTAndSend = () => {
      if (!pttActiveRef.current) return;
      pttActiveRef.current = false;
      pttTokenRef.current++; // invalidate any in-flight getUserMedia
      const mr = recorderRef.current;
      if (!mr || mr.state === "inactive") {
        setPttState("idle");
        return;
      }
      setPttState("transcribing");
      mr.onstop = async () => {
        try {
          mr.stream.getTracks().forEach((t) => t.stop());
        } catch {}
        recorderRef.current = null;
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        audioChunksRef.current = [];
        if (blob.size < 500) {
          setPttState("idle");
          return;
        }
        try {
          const fd = new FormData();
          fd.append("file", blob, "audio.webm");
          const r = await fetch("/api/transcribe", { method: "POST", body: fd });
          if (r.ok) {
            const { text } = (await r.json()) as { text: string };
            const trimmed = (text ?? "").trim();
            if (trimmed) {
              const ws = wsRef.current;
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "input", data: trimmed }));
              }
            }
            setPttState("idle");
          } else {
            const body = (await r.json().catch(() => null)) as { error?: string } | null;
            setPttError(body?.error ?? `transcribe HTTP ${r.status}`);
            setPttState("error");
            setTimeout(() => setPttState("idle"), 3000);
          }
        } catch (e) {
          setPttError(`transcribe: ${(e as Error).message}`);
          setPttState("error");
          setTimeout(() => setPttState("idle"), 3000);
        }
      };
      try { mr.stop(); } catch {}
    };

    startPTTRef.current = startPTT;
    stopPTTRef.current = stopPTTAndSend;

    const focusHelper = () => {
      const helper = hostRef.current?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      if (helper && document.activeElement !== helper) helper.focus();
    };

    // Hold-detect: short tap = type a literal space; ~250ms hold = PTT.
    const HOLD_MS = 250;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;

      // Auto-recover focus to the terminal whenever the user presses
      // space anywhere on this page. Lets us drop the "must be focused"
      // gate that previously made PTT silently fail after the user
      // clicked any non-terminal UI (lock icon, header buttons, etc.).
      focusHelper();

      // Once PTT is active, swallow every space keydown — including
      // OS auto-repeat — so xterm doesn't keep typing spaces into
      // claude's input while we're recording.
      if (pttActiveRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.repeat) return;

      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        // Hold detected. Backspace the literal space we just typed,
        // then kick off recording.
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: "\x7f" }));
        }
        startPTT();
      }, HOLD_MS);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
        return;
      }
      if (pttActiveRef.current) {
        e.preventDefault();
        e.stopPropagation();
        stopPTTAndSend();
      }
    };

    const onWindowFocus = () => focusHelper();
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    return () => {
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      if (holdTimer) clearTimeout(holdTimer);
      try { recorderRef.current?.stream.getTracks().forEach((t) => t.stop()); } catch {}
      recorderRef.current = null;
      pttActiveRef.current = false;
    };
  }, []);

  return (
    <div className={`relative h-full w-full ${className ?? ""}`}>
      <div
        ref={hostRef}
        tabIndex={0}
        className="absolute inset-0 overflow-hidden rounded-md bg-bg-terminal outline-none"
        onMouseDown={() => termRef.current?.focus()}
      />
      {pttState !== "idle" && (
        <div
          className={`pointer-events-none absolute top-3 right-3 rounded-full px-3 py-1 text-[10.5px] font-medium uppercase tracking-wider shadow-lg backdrop-blur ${
            pttState === "recording"
              ? "bg-term-red/90 text-white"
              : pttState === "transcribing"
              ? "bg-term-violet/90 text-white"
              : "bg-black/80 text-term-red"
          }`}
        >
          {pttState === "recording" && "● recording — release to send"}
          {pttState === "transcribing" && "transcribing…"}
          {pttState === "error" && (pttError ?? "mic error")}
        </div>
      )}
    </div>
  );
}
