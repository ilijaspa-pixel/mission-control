import { ConsoleShell } from "@/components/ConsoleShell";
import { loadShellData } from "@/lib/shell-data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// One console inside the app shell. Default view is the Grok-style chat
// (history loaded here, like /s/[id]); the raw xterm backed by node-pty is
// behind the terminal toggle. id = "new" spawns a fresh session (terminal
// only until it shows up); an id with no transcript also falls back to the
// terminal, which attempts `claude --resume <id>`.
export default async function LivePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string; flavor?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const mode: "new" | "resume" = id === "new" ? "new" : "resume";
  const explicitMode = sp.mode === "new" || sp.mode === "resume" ? sp.mode : undefined;
  const flavor: "claude" | "claude2" = sp.flavor === "claude2" ? "claude2" : "claude";
  const { sessions, recent } = await loadShellData(id === "new" ? "new" : id);
  return (
    <ConsoleShell
      initialSessions={sessions}
      initialRecent={recent}
      initialSelected={{ id, mode: explicitMode ?? mode, flavor }}
    />
  );
}
