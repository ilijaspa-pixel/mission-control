import { ConsoleShell } from "@/components/ConsoleShell";
import { flavorOf } from "@/lib/console-meta";
import { loadShellData } from "@/lib/shell-data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// App shell: sidebar of consoles + one Grok-style console on the right.
// The old tile grid lives at /grid.
export default async function HomePage() {
  const { sessions, recent, selected } = await loadShellData(null);
  return (
    <ConsoleShell
      initialSessions={sessions}
      initialRecent={recent}
      initialSelected={
        selected ? { id: selected.id, mode: "resume", flavor: flavorOf(selected) } : null
      }
    />
  );
}
