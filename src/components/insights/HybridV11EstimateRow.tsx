"use client";

import { formatImpactDelta } from "@/utils/currentHalfRunImpact";
import type { HybridV11Estimate } from "@/types/hybridPerformanceV11";
import type { CombinationItem } from "@/types/hybridPerformanceV11";
import { HYBRID_FAMILY_LABEL } from "./HybridEstimateRow";

const label = (minutes: number) => `~${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const paceLabel = (s: number) => `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/mi`;
const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const STATUS_LABEL = { available: "Available", provisional: "Provisional", unavailable: "Unavailable" } as const;
const CAUSE_TEXT: Record<NonNullable<HybridV11Estimate["unavailableCause"]>, string> = {
  no_performance_evidence: "No qualifying race, time trial or strong sustained effort is available.",
  anchor_expired_no_contemporary_evidence: "The only qualifying race is older than 180 days and no strong recent effort replaces it.",
  insufficient_independent_evidence: "Qualifying evidence is too thin to estimate a time.",
  insufficient_endurance_preparation: "Recent long-run and volume evidence is too low to carry a half-marathon time.",
  invalid_input: "The inputs could not be evaluated.",
};
const KIND_LABEL: Record<CombinationItem["kind"], string> = {
  confirmed_race: "Confirmed race", recorded_race: "Recorded race", labelled_race_run: "Race-labelled run", whole_run_effort: "Strong whole-run effort", sustained_segment: "Sustained segment of a longer run",
};
const FLAG_TEXT: Record<CombinationItem["flags"][number], string> = {
  isolated_uncorroborated: "isolated, down-weighted until corroborated", slower_than_estimate_lower_bound: "slower than the estimate, weaker evidence", weather_missing: "no recorded weather",
};
const EXCLUSION_TEXT: Record<string, string> = {
  fast_segment_not_hr_supported: "a fast segment whose run had ordinary heart rate", fast_segment_heat_inflated_hr: "a fast segment in heat", fast_segment_host_timing_discrepancy: "a fast segment in a run with inconsistent timing",
  fast_segment_host_implausible: "a fast segment in a run with implausible pace or distance", fast_segment_host_owner_corrected: "a fast segment in a run you corrected by hand", fast_segment_host_indoor: "a fast segment on a treadmill",
  fast_segment_no_athlete_hr_reference: "a fast segment with no personal heart-rate reference yet", fast_segment_host_missing_hr: "a fast segment in a run without heart rate", fast_segment_expired: "a fast segment older than 180 days",
  same_day_duplicate_segment: "a second effort on the same day (one per day counts)",
};
const DOMINANCE_TEXT = { none: "no race carries the estimate", minor: "races carry a minor share", shared: "races and newer efforts share the estimate", dominant: "the estimate is still race-dominated" } as const;

/** One plain-language answer to "why this number, and what moved it". Never invents a factor that did not contribute. */
export function hybridV11Reasons(e: HybridV11Estimate): string[] {
  if (e.seconds === null) return [];
  const out: string[] = [];
  const c = e.combination, i = e.influence;
  if (c.race && c.recent) out.push(`Races carry ${pct(c.raceShare)} and ${c.recent.count} newer ${c.recent.count === 1 ? "effort" : "efforts"} ${pct(c.recentShare)} of the evidence${c.latestRaceAgeDays !== null ? ` (latest race ${c.latestRaceAgeDays} days old)` : ""}.`);
  else if (c.race) out.push(`Only your ${c.latestRaceDate ? dateLabel(c.latestRaceDate) + " " : ""}race${c.race.count > 1 ? "s" : ""} qualif${c.race.count > 1 ? "y" : "ies"} (${c.latestRaceAgeDays} days old): the number is the race result converted to this distance and age has not changed it, only how certain it is.`);
  else out.push(`No race anchors this estimate; ${c.recent?.count ?? 0} independent strong efforts do.`);
  if (i.displacementSeconds !== null && Math.abs(i.displacementSeconds) >= 1) out.push(`Newer evidence moved the base ${formatImpactDelta(Math.abs(i.displacementSeconds))} ${i.displacementSeconds < 0 ? "faster" : "slower"} than the race alone implies.`);
  const moved = e.contributions.filter(x => (x.family === "physiological_trend" || x.family === "endurance_readiness") && x.status === "used" && Math.abs(x.seconds) >= 1);
  for (const m of moved) out.push(`${HYBRID_FAMILY_LABEL[m.family]} ${m.seconds < 0 ? "faster" : "slower"} by ${formatImpactDelta(Math.abs(m.seconds))}.`);
  if (!moved.length && (i.displacementSeconds === null || Math.abs(i.displacementSeconds) < 1)) out.push("No sustained physiological, endurance or newer-performance change moves it.");
  return out;
}

/**
 * Compact row for the experimental hybrid v1.1 estimate, shown BESIDE the official and HR-enhanced estimates.
 * Always labelled experimental and provisional; the official estimate stays the primary prediction. The diagnostics live inside
 * the expandable "How this estimate is built" so the primary card is not cluttered.
 */
export function HybridV11EstimateRow({ estimate: e, detailed = false }: { estimate: HybridV11Estimate; detailed?: boolean }) {
  const diff = e.comparison.differenceVsOfficialSeconds;
  const faster = diff !== null && diff < 0;
  const reasons = hybridV11Reasons(e), c = e.combination, inf = e.influence;
  const v1d = e.comparison.differenceVsHybridV1Seconds;
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg border border-border bg-surface p-3" data-testid="hybrid-v11-estimate" data-status={e.status}>
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-textSecondary">Experimental — Hybrid Performance Model v1.1</h4>
        <span className="shrink-0 rounded-md bg-card px-2 py-0.5 text-xs font-medium text-textSecondary" data-testid="hybrid-v11-status">{STATUS_LABEL[e.status]}</span>
      </div>
      {e.minutes !== null && e.paceSecondsPerMile !== null ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums" data-testid="hybrid-v11-value">
            <span className="text-lg font-bold text-textPrimary">{label(e.minutes)}</span>
            <span className="font-semibold text-textSecondary">{paceLabel(e.paceSecondsPerMile)}</span>
            <span className={diff !== null && Math.abs(diff) >= 1 ? (faster ? "text-success" : "text-warning") : "text-textSecondary"} data-testid="hybrid-v11-difference">
              {diff === null ? "official estimate unavailable for comparison" : Math.abs(diff) < 1 ? "same as the official estimate"
                : `${formatImpactDelta(Math.abs(diff))} ${faster ? "faster" : "slower"} than the official estimate`}
            </span>
          </p>
          {e.sensitivityRange && <p className="text-xs text-textSecondary" data-testid="hybrid-v11-range">
            Assumption range {hms(e.sensitivityRange.fastSeconds)}–{hms(e.sensitivityRange.slowSeconds)} · not a statistical interval · confidence {e.confidence ?? "low"}.</p>}
        </>
      ) : <p className="text-sm font-semibold text-textPrimary" data-testid="hybrid-v11-value">Not available</p>}
      <p className="text-sm text-textSecondary" data-testid="hybrid-v11-reason">{reasons.length ? reasons[0] : (e.fallbackReason ?? (e.unavailableCause ? CAUSE_TEXT[e.unavailableCause] : ""))}</p>
      {e.seconds !== null && inf.raceDominance === "dominant" && inf.latestRaceDate && <p className="text-xs text-textSecondary" data-testid="hybrid-v11-race-dependent">
        Still race-dependent: {pct(inf.raceShare)} rests on your {dateLabel(inf.latestRaceDate)} race ({inf.latestRaceAgeDays} days old); no newer qualifying effort has displaced it.</p>}
      {e.seconds !== null && e.conflicts.length > 0 && <p className="text-xs text-warning" data-testid="hybrid-v11-conflict">Signals disagree: {e.conflicts.map(x => x.detail).join(" ")} Reported, not averaged away; confidence is low.</p>}
      <p className="text-xs text-textSecondary">Experimental and provisional; not independently validated. The official estimate is unchanged and remains the primary prediction.</p>
      <details className="text-xs text-textSecondary" data-testid="hybrid-v11-details">
        <summary className="cursor-pointer py-1.5 font-semibold text-primary">How this estimate is built</summary>
        <div className="space-y-3 pt-1">
          <p>Demonstrated performances (races, strong efforts, and strong sustained portions of longer runs) are combined by how certain each one is: certainty falls with age and with how far the distance must be extrapolated, and several efforts from one training block are not treated as fully independent. Ordinary easy running is never treated as a maximal effort, and an old race is not made faster or slower just because it aged.</p>
          {e.seconds !== null && <div data-testid="hybrid-v11-influence" className="space-y-1">
            <p className="font-semibold text-textPrimary">What the estimate rests on</p>
            <ul className="list-disc pl-5">
              {inf.latestRaceDate ? <li>Latest race: {dateLabel(inf.latestRaceDate)}, {inf.latestRaceAgeDays} days ago · carries {pct(inf.raceShare)} of the evidence ({DOMINANCE_TEXT[inf.raceDominance]}).</li> : <li>No race contributes.</li>}
              <li>Newer qualified efforts: {c.recent?.count ?? 0} · carry {pct(inf.recentShare)} · {inf.newerEvidenceDisplacedRace ? "newer evidence now carries the majority" : "they have not displaced the race"}.</li>
              <li>Independent observations used: {inf.independentObservations}.</li>
              <li>Physiological trend {inf.physiologicalTrendApplied ? `applied (${inf.physiologyAdjustmentSeconds < 0 ? "−" : "+"}${formatImpactDelta(Math.abs(inf.physiologyAdjustmentSeconds))})` : "did not change the estimate"}.</li>
              <li>Evidence base before physiology and endurance: {hms(c.baseSeconds!)}; after: {hms(e.seconds)}.</li>
              <li>Status: {inf.provisional ? "provisional" : "available"}{inf.provisionalReasons.length ? ` — ${inf.provisionalReasons.join(" ")}` : "."}</li>
            </ul>
          </div>}
          {reasons.length > 1 && <div data-testid="hybrid-v11-why"><p className="font-semibold text-textPrimary">Why this number</p><ul className="list-disc pl-5">{reasons.map(r => <li key={r}>{r}</li>)}</ul></div>}
          {c.items.length > 0 && <div data-testid="hybrid-v11-items"><p className="font-semibold text-textPrimary">Evidence used (effective share of the calculation)</p>
            <ul className="list-disc pl-5">{c.items.map(i => <li key={i.clusterId}>{KIND_LABEL[i.kind]} · {dateLabel(i.date)} ({i.ageDays} d) · {pct(i.effectiveShare)}{i.flags.length ? ` · ${i.flags.map(f => FLAG_TEXT[f]).join("; ")}` : ""}</li>)}</ul></div>}
          {(Object.keys(inf.excludedInformative).length > 0 || c.ignored.length > 0) && <div data-testid="hybrid-v11-excluded"><p className="font-semibold text-textPrimary">Potentially informative, not used</p>
            <ul className="list-disc pl-5">{Object.entries(inf.excludedInformative).map(([k, n]) => <li key={k}>{n} × {EXCLUSION_TEXT[k] ?? k.replaceAll("_", " ")}</li>)}
              {c.ignored.filter(x => x.reason === "segment_slower_than_estimate").length > 0 && <li>{c.ignored.filter(x => x.reason === "segment_slower_than_estimate").length} × a sustained segment slower than the estimate (a slow segment is not evidence of lost capability)</li>}</ul></div>}
          <ul className="space-y-1" data-testid="hybrid-v11-families">
            {e.contributions.map(x => <li key={x.family}><span className="font-semibold text-textPrimary">{HYBRID_FAMILY_LABEL[x.family]}</span> · {x.status.replace("_", " ")}
              {x.status === "used" && x.family !== "demonstrated_performance" && x.family !== "race_history" ? ` · ${x.seconds < 0 ? "−" : "+"}${formatImpactDelta(Math.abs(x.seconds))}, ${Math.round(x.influence * 100)}% influence` : ""}. {x.explanation}</li>)}
          </ul>
          <div data-testid="hybrid-v11-physiology" className="space-y-1"><p className="font-semibold text-textPrimary">Physiological inputs</p>
            <ul className="list-disc pl-5"><li>{e.inputs.vo2.note}</li><li>{e.inputs.hrStreams.note}</li>
              {e.physiology?.status === "available" && <li>{e.physiology.interpretation.observed[0]}</li>}</ul></div>
          {e.comparison.hybridV1Seconds !== null && v1d !== null && <p data-testid="hybrid-v11-vs-v1">Previous hybrid v1 (kept for comparison): {hms(e.comparison.hybridV1Seconds)} · v1.1 is {Math.abs(v1d) < 1 ? "the same" : `${formatImpactDelta(Math.abs(v1d))} ${v1d < 0 ? "faster" : "slower"}`}.</p>}
          <p data-testid="hybrid-v11-evidence-counts">Evidence quality: {e.evidenceQuality}. Excluded or expired: {e.qualification.base.expired.length} older than 180 days; ordinary training runs counted but never used as maximal effort: {e.qualification.base.counts.ordinary_training}; sustained segments qualified: {e.qualification.segments.qualified}.</p>
          {e.missing.length > 0 && <div data-testid="hybrid-v11-missing"><p className="font-semibold text-textPrimary">Missing information</p><ul className="list-disc pl-5">{e.missing.map(m => <li key={m}>{m}</li>)}</ul></div>}
          {detailed && <ul className="list-disc space-y-1 pl-5">{e.assumptions.map(a => <li key={a}>{a}</li>)}</ul>}
          <p>Model {e.version} · evidence {e.qualification.version} · combination {c.version} · calculation cutoff {e.asOf} · data through {e.dataThrough ?? "n/a"}.</p>
        </div>
      </details>
    </div>
  );
}
