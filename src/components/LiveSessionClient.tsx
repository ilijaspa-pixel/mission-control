"use client";

// One console, Grok-style. Default view is the chat (GrokChat); the raw
// xterm (InteractiveTerminal) sits behind the terminal icon and is only
// MOUNTED while that toggle is on, because mounting opens the PTY
// WebSocket and reattaches the session. Rendered inside ConsoleShell.

import { useEffect, useRef, useState } from "react";
import type { SessionSnapshot, TimelineEvent } from "@/lib/types";
import { TERMINAL_TOGGLE_KEY } from "@/lib/console-meta";
import { InteractiveTerminal } from "./InteractiveTerminal";
import { GrokChat, Icon } from "./GrokChat";
import s from "./GrokChat.module.css";

type Mode = "new" | "resume";
type Flavor = "claude" | "claude2";

export function LiveSessionClient({
  sessionId,
  mode,
  flavor = "claude",
  snapshot,
  events,
  onToggleSidebar,
  onEnded,
}: {
  sessionId: string;
  mode: Mode;
  flavor?: Flavor;
  /** Snapshot of the session (null for "new" until it is discovered). */
  snapshot: SessionSnapshot | null;
  events: TimelineEvent[];
  onToggleSidebar?: () => void;
  onEnded?: () => void;
}) {
  const closeTerminalRef = useRef<(() => void) | null>(null);
  const hasChat = !!snapshot;
  const realId = snapshot?.id ?? (sessionId === "new" ? null : sessionId);

  // Terminal toggle, remembered per session. `null` = not hydrated yet
  // (render nothing heavy, never mount the terminal by accident).
  const [terminalOn, setTerminalOn] = useState<boolean | null>(null);
  // Props for the mounted terminal, frozen at mount time so a "new"
  // console doesn't respawn when its real id is discovered.
  const [termSpec, setTermSpec] = useState<{ id: string; mode: Mode } | null>(null);

  const specNow = (): { id: string; mode: Mode } =>
    snapshot ? { id: snapshot.id, mode: "resume" } : { id: sessionId, mode };

  useEffect(() => {
    let on = !hasChat;
    if (hasChat && realId) {
      try {
        on = localStorage.getItem(TERMINAL_TOGGLE_KEY(realId)) === "1";
      } catch {}
    }
    if (on) setTermSpec(specNow());
    setTerminalOn(on);
    // Only on mount: this pane is keyed per console by the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setToggle = (on: boolean) => {
    if (on) setTermSpec(specNow());
    else setTermSpec(null);
    setTerminalOn(on);
    if (realId) {
      try {
        localStorage.setItem(TERMINAL_TOGGLE_KEY(realId), on ? "1" : "0");
      } catch {}
    }
  };

  // Two-click arm for End session: icon-only buttons are easy to hit.
  const [endArmed, setEndArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  const endSession = async () => {
    if (!endArmed) {
      setEndArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setEndArmed(false), 2500);
      return;
    }
    setEndArmed(false);
    try {
      closeTerminalRef.current?.();
    } catch {}
    if (realId) {
      try {
        await fetch("/api/pty-kill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: realId }),
        });
      } catch {}
    }
    setTimeout(() => onEnded?.(), 120);
  };

  const showTerminal = terminalOn === true && termSpec;
  // Keep the chat mounted if the snapshot blinks to null for a moment (SSE re-sync):
  // swapping it for an empty div remounted the chat and wiped a half-typed message.
  const lastSnap = useRef(snapshot);
  if (snapshot) lastSnap.current = snapshot;
  const shownSnap = snapshot ?? lastSnap.current;

  return (
    <div className={`${s.root} flex h-full min-w-0 flex-1 flex-col bg-black`}>
      {/* Top bar: sidebar toggle left, quiet outline icons right. */}
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <div className="flex items-center gap-1">
          {onToggleSidebar && (
            <button type="button" title="Consoles" onClick={onToggleSidebar} className={s.iconBtn}>
              <span className="md:hidden"><Icon d="M4 7h16M4 12h16M4 17h10" /></span>
              <span className="hidden md:block"><Icon>
                <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
                <path d="M9.5 4.5v15" />
              </Icon></span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {hasChat && (
            <button
              type="button"
              title={terminalOn ? "Back to chat" : "Show terminal"}
              onClick={() => setToggle(!terminalOn)}
              className={`${s.iconBtn} ${terminalOn ? s.iconBtnActive : ""}`}
            >
              {terminalOn ? (
                <Icon d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3.5 21l1.4-5.1A8.5 8.5 0 1 1 21 12z" />
              ) : (
                <Icon>
                  <rect x="3" y="4.5" width="18" height="15" rx="3" />
                  <path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />
                </Icon>
              )}
            </button>
          )}
          <button
            type="button"
            title={endArmed ? "Click again to end this session" : "End session"}
            onClick={endSession}
            className={`${s.iconBtn} ${endArmed ? "!w-auto gap-1.5 !bg-[#2a1212] px-3 !text-[#ff8a85]" : ""}`}
            style={endArmed ? { display: "flex" } : undefined}
          >
            <Icon d="M18 6L6 18M6 6l12 12" />
            {endArmed && <span className="text-[13px]">End session?</span>}
          </button>
        </div>
      </div>

      {showTerminal ? (
        <div className="mx-auto flex min-h-0 w-full max-w-[1100px] flex-1 px-3 pb-3">
          <div className="relative flex min-h-0 flex-1 overflow-hidden bg-black">
            <InteractiveTerminal
              key={`${termSpec.id}:${termSpec.mode}`}
              sessionId={termSpec.id}
              mode={termSpec.mode}
              flavor={flavor}
              closeRef={closeTerminalRef}
              className="p-2"
            />
          </div>
        </div>
      ) : shownSnap ? (
        // Also the pre-hydration paint: the chat opens no WebSocket.
        <GrokChat snapshot={shownSnap} events={events} onOpenTerminal={() => setToggle(true)} />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}
