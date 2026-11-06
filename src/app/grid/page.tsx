import { listSnapshots, getFullSession } from "@/lib/store";
import { HubClient } from "@/components/HubClient";
import type { TimelineEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function GridPage() {
  const sessions = await listSnapshots();
  const recent: Record<string, TimelineEvent[]> = {};
  for (const s of sessions) {
    const full = getFullSession(s.id);
    // Send the full timeline (capped at FULL_CAP=5000 in the parser)
    // so the tile body has real scrollback the user can browse. The
    // older 24-event slice was just enough to fill the visible area
    // — there was nothing to scroll up to.
    recent[s.id] = (full?.events ?? full?.recent ?? []).slice(-300);
  }
  return <HubClient initialSessions={sessions} initialRecent={recent} />;
}
