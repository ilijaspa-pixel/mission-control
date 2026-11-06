import { notFound } from "next/navigation";
import { getFullSession } from "@/lib/store";
import { SessionDetailClient } from "@/components/SessionDetailClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const full = getFullSession(id);
  if (!full) notFound();
  const { events, ...snapshot } = full;
  return (
    <SessionDetailClient
      initialSnapshot={snapshot}
      initialEvents={events}
    />
  );
}
