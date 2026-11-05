"use client";

import { lazy, Suspense, useRef, useState, type ReactNode, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { usePerformanceEvidence } from "@/contexts/PerformanceEvidenceContext";
import { PERFORMANCE_ANALYSIS_QUERY } from "@/lib/performanceAnalysisNavigation";
import {
  EstimateDetailsButton, InsightsDialog, INSIGHTS_DIALOG_TRIGGER_CLASS,
} from "@/components/insights/EstimateDetailsDialog";

const PerformanceAnalysisPanel = lazy(() => import("@/components/PerformanceAnalysisPanel")
  .then(module => ({ default: module.PerformanceAnalysisPanel })));

function PerformanceAnalysisDialog({ onClose, trigger }: {
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const { state, getSnapshot } = usePerformanceEvidence();
  const processing = state.publication === "processing";

  return <InsightsDialog title="Performance Analysis" testId="performance-analysis" returnFocusRef={trigger}
    onClose={() => {
      // Read the live state even if Analyze and a dismissal happen before React commits.
      if (getSnapshot().publication !== "processing") onClose();
    }}
    dismissalMessage={processing ? "Analysis is running. You can close this dialog when it finishes." : undefined}>
    <Suspense fallback={<p role="status" className="text-sm text-textSecondary">Loading Performance Analysis…</p>}>
      <PerformanceAnalysisPanel />
    </Suspense>
  </InsightsDialog>;
}

function PerformanceActions({ estimateDetails }: { estimateDetails?: ReactNode }) {
  const linkedAnalysis = useSearchParams()?.has(PERFORMANCE_ANALYSIS_QUERY);
  const [dialog, setDialog] = useState<"estimate" | "analysis" | null>(null);
  const open = linkedAnalysis ? "analysis" : dialog;
  const analysisTrigger = useRef<HTMLButtonElement>(null);
  const estimateTrigger = useRef<HTMLButtonElement>(null);

  function closeAnalysis() {
    setDialog(null);
    if (linkedAnalysis) {
      const url = new URL(window.location.href);
      url.searchParams.delete(PERFORMANCE_ANALYSIS_QUERY);
      window.history.replaceState(null, "", url);
    }
  }

  return <>
    <div className="flex gap-2 [&>button]:min-w-0 [&>button]:flex-1 [&>button]:justify-center [&>button]:text-center sm:[&>button]:flex-none">
      <button type="button" ref={analysisTrigger} aria-haspopup="dialog" aria-expanded={open === "analysis"}
        data-testid="view-performance-analysis" className={INSIGHTS_DIALOG_TRIGGER_CLASS} onClick={() => setDialog("analysis")}>
        Performance Analysis
      </button>
      {estimateDetails && <EstimateDetailsButton buttonRef={estimateTrigger} open={open === "estimate"} onClick={() => setDialog("estimate")} />}
    </div>
    {open === "estimate" && estimateDetails && (
      <InsightsDialog title="Estimate Details" testId="estimate-details" returnFocusRef={estimateTrigger} onClose={() => setDialog(null)}>
        {estimateDetails}
      </InsightsDialog>
    )}
    {open === "analysis" && <PerformanceAnalysisDialog onClose={closeAnalysis} trigger={analysisTrigger} />}
  </>;
}

export function PlanPerformanceActions(props: { estimateDetails?: ReactNode }) {
  return <Suspense fallback={null}><PerformanceActions {...props} /></Suspense>;
}
