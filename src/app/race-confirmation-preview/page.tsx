import { notFound } from "next/navigation";
import { isRacePerformanceEnabled } from "@/lib/racePerformanceGate";

/** Public synthetic acceptance only; never mounts the authenticated app shell. */
export default async function RaceConfirmationPreviewPage() {
  if (!isRacePerformanceEnabled()) notFound();
  const { RaceConfirmationPreview } = await import("@/components/races/RaceConfirmationPreview");
  return <RaceConfirmationPreview />;
}
