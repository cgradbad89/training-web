"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { PERFORMANCE_ANALYSIS_QUERY } from "@/lib/performanceAnalysisNavigation";
import {
  EstimateDetailsButton, InsightsDialog,
} from "@/components/insights/EstimateDetailsDialog";

/** The legacy "Performance Analysis" workflow was retired from navigation (Hybrid v1.1 and
 * Race-Day Forecast v2 supersede it). Its saved documents are untouched and nothing here reads
 * them. An old bookmark or link (`?performance-analysis=1`) is acknowledged once, then the
 * query is removed from the address bar. No focus is moved and no data is requested. */
function RetiredLinkNotice() {
  const linked = useSearchParams()?.has(PERFORMANCE_ANALYSIS_QUERY) ?? false;
  // Latch during render so the notice survives the query being stripped below.
  const [visible, setVisible] = useState(linked);
  const [seen, setSeen] = useState(linked);
  if (linked && !seen) { setSeen(true); setVisible(true); }
  useEffect(() => {
    if (!linked) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(PERFORMANCE_ANALYSIS_QUERY);
    window.history.replaceState(null, "", url);
  }, [linked]);
  if (!visible) return null;
  return <div data-testid="performance-analysis-retired" role="status"
    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-textSecondary [overflow-wrap:anywhere]">
    <span>The manual Performance Analysis view has been retired. Estimate Details now explains the Hybrid Performance Model v1.1 evidence. Saved analyses are preserved.</span>
    <button type="button" className="min-h-11 rounded-lg border border-border px-3 text-xs font-semibold text-textPrimary" onClick={() => setVisible(false)}>Dismiss</button>
  </div>;
}

function PerformanceActions({ estimateDetails }: { estimateDetails?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const estimateTrigger = useRef<HTMLButtonElement>(null);
  return <>
    <RetiredLinkNotice />
    {estimateDetails && <div className="flex gap-2 [&>button]:min-w-0 [&>button]:flex-1 [&>button]:justify-center [&>button]:text-center sm:[&>button]:flex-none">
      <EstimateDetailsButton buttonRef={estimateTrigger} open={open} onClick={() => setOpen(true)} />
    </div>}
    {open && estimateDetails && (
      <InsightsDialog title="Estimate Details" testId="estimate-details" returnFocusRef={estimateTrigger} onClose={() => setOpen(false)}>
        {estimateDetails}
      </InsightsDialog>
    )}
  </>;
}

export function PlanPerformanceActions(props: { estimateDetails?: ReactNode }) {
  return <Suspense fallback={null}><PerformanceActions {...props} /></Suspense>;
}
