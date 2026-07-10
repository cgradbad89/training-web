import { CheckCircle2, MinusCircle, XCircle, Circle } from "lucide-react";
import { type RunEntryStatus } from "@/utils/planMatching";

interface RunStatusIconProps {
  status: RunEntryStatus;
  size?: number;
}

/**
 * Shared status→icon/color mapping for a planned run entry. Mirrors the
 * dashboard's inline `StatusIcon` (PlanProgressCard) exactly — single source
 * for any surface rendering the four `RunEntryStatus` states.
 */
export function RunStatusIcon({ status, size = 15 }: RunStatusIconProps) {
  switch (status) {
    case "met":
      return <CheckCircle2 size={size} className="text-success shrink-0" />;
    case "partial":
      return <MinusCircle size={size} className="text-warning shrink-0" />;
    case "missed":
      return <XCircle size={size} className="text-danger shrink-0" />;
    case "upcoming":
      return <Circle size={size} className="text-textSecondary shrink-0" />;
  }
}
