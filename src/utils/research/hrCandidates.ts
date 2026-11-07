/**
 * Phase 3O — RESEARCH-ONLY comparison of HR-informed candidates. Never imported by live code
 * (test-enforced). Reports coverage and the pace-at-comparable-HR contrast of each candidate on the
 * same eligible runs and windows; only the official v2 baseline and the selected HR-enhanced
 * candidate produce a finish time. The others are DESCRIPTIVE contrasts: no race-time transform is
 * defined for them, so their accuracy is "not assessed", never zero error.
 *
 * Output is aggregate numbers and rule text. It never carries workout identifiers.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { buildComparableEffortFunnel } from "../comparableEffortFunnel";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../hrEnhancedPerformance";
import { median } from "../hrEffortSignal";
import { performanceLocalDate, shiftPerformanceDate } from "../performanceEvidence";
import { pairResearchRuns, selectResearchRuns } from "../workoutRaceResearch";

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
export type HrCandidateId = "v2-official" | "strict-comparable-effort" | "similar-hr-band" | "same-route-hr-adjusted" | "multiweek-efficiency" | "hr-enhanced-selected";

export interface HrCandidateRow {
  id: HrCandidateId;
  status: "available" | "insufficient";
  reason: string;
  sample: Record<string, number>;
  /** Percent change in pace at comparable HR (negative = faster); null when not applicable. */
  contrastPercent: number | null;
  /** Percent per 28 days for the efficiency trend candidate. */
  trendPercentPer28d?: number | null;
  finishSeconds: number | null;
}
export interface HrCandidateComparison { asOf: string; anchorDate: string | null; rows: HrCandidateRow[] }

const monday = (date: string) => shiftPerformanceDate(date, -((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7));
const dayNum = (date: string) => Date.parse(date + "T00:00:00Z") / 86_400_000;
const hard = (t: string) => /tempo|interval|race|fartlek|hill repeat/i.test(t);
const indoor = (t: string) => /treadmill|indoor/i.test(t);

function steadyOutdoor(runs: readonly ResearchRun[], raceIds: ReadonlySet<string>): ResearchRun[] {
  return runs.filter(r => !raceIds.has(r.workout.workoutId) && !hard(r.workout.displayType ?? "") && !indoor(r.workout.displayType ?? "")
    && r.workout.hasRoute && r.workout.durationSeconds >= 1200 && r.workout.durationSeconds <= 7200
    && typeof r.workout.avgHeartRate === "number" && r.workout.avgHeartRate >= 40 && r.workout.avgHeartRate <= 220
    && r.paceSecondsPerMile >= 180 && r.paceSecondsPerMile <= 1800);
}
function theilSen(x: number[], y: number[]): number | null {
  const s: number[] = [];
  for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) if (Math.abs(x[j] - x[i]) >= 1e-9) s.push((y[j] - y[i]) / (x[j] - x[i]));
  return s.length ? median(s) : null;
}

export function compareHrCandidates(input: Input): HrCandidateComparison {
  const official = estimateCurrentHalfMarathon(input);
  const date = performanceLocalDate(input.asOf, input.timeZone);
  const anchorDate = official.anchor?.raceDate ?? null;
  const rows: HrCandidateRow[] = [];
  const officialSeconds = official.finishMinutes === null ? null : official.baselineSeconds! + official.adjustmentSeconds;
  rows.push({ id: "v2-official", status: officialSeconds === null ? "insufficient" : "available", reason: officialSeconds === null ? official.reason : "ok",
    sample: { matchedPairs: official.diagnostics.matchedPairs }, contrastPercent: null, finishSeconds: officialSeconds });

  const { runs } = selectResearchRuns({ ...input, overrides: input.overrides ?? {}, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const funnel = buildComparableEffortFunnel(input);
  const pairs = anchorDate && official.anchor ? pairResearchRuns(runs, anchorDate, date, input.asOf, raceIds, 35).pairs : [];
  rows.push({ id: "strict-comparable-effort", status: funnel.paceWeight > 0 ? "available" : "insufficient", reason: funnel.paceWeight > 0 ? "ok" : funnel.verdict,
    sample: { pairs: funnel.matchedPairs, weeks: funnel.matchedWeeks, effectivePairs: Math.round(funnel.effectivePairs * 100) / 100 },
    contrastPercent: pairs.length ? (median(pairs.map(p => p.paceRatio)) - 1) * 100 : null, finishSeconds: null });

  const hrEnh = estimateHrEnhancedHalfMarathon(input, { official });
  if (!anchorDate) {
    for (const id of ["similar-hr-band", "same-route-hr-adjusted", "multiweek-efficiency"] as const)
      rows.push({ id, status: "insufficient", reason: "No race anchor.", sample: {}, contrastPercent: null, finishSeconds: null });
  } else {
    const steady = steadyOutdoor(runs, raceIds);
    const base = steady.filter(r => r.date >= shiftPerformanceDate(anchorDate, -63) && r.date <= shiftPerformanceDate(anchorDate, -8));
    const recent = steady.filter(r => r.date > anchorDate && r.date >= shiftPerformanceDate(date, -42) && r.date <= shiftPerformanceDate(date, -1));
    const hr = (r: ResearchRun) => r.workout.avgHeartRate as number;
    const weeks = (a: ResearchRun[]) => new Set(a.map(r => monday(r.date))).size;

    // Similar-HR band: plain medians inside ±4 bpm of the pooled median; no slope, no shrinkage.
    const center = base.length + recent.length ? median([...base, ...recent].map(hr)) : NaN;
    const inB = base.filter(r => Math.abs(hr(r) - center) <= 4), inR = recent.filter(r => Math.abs(hr(r) - center) <= 4);
    const bandOk = inB.length >= 5 && inR.length >= 5 && weeks(inB) >= 3 && weeks(inR) >= 3;
    rows.push({ id: "similar-hr-band", status: bandOk ? "available" : "insufficient",
      reason: bandOk ? "ok" : "Fewer than 5 runs / 3 weeks per period inside ±4 bpm.",
      sample: { baselineRuns: inB.length, recentRuns: inR.length, baselineWeeks: weeks(inB), recentWeeks: weeks(inR) },
      contrastPercent: bandOk ? (median(inR.map(r => r.paceSecondsPerMile)) / median(inB.map(r => r.paceSecondsPerMile)) - 1) * 100 : null, finishSeconds: null });

    // Same-route: clusters with >=2 runs in each period; slope from the pooled runs; median of per-cluster contrasts.
    const slope = (() => { const all = [...base, ...recent]; return all.length >= 8 ? Math.min(0, theilSen(all.map(hr), all.map(r => Math.log(r.paceSecondsPerMile))) ?? 0) : 0; })();
    const clusters = new Map<string, { b: ResearchRun[]; r: ResearchRun[] }>();
    for (const r of base) if (r.workout.routeClusterId) { const g = clusters.get(r.workout.routeClusterId) ?? { b: [], r: [] }; g.b.push(r); clusters.set(r.workout.routeClusterId, g); }
    for (const r of recent) if (r.workout.routeClusterId) { const g = clusters.get(r.workout.routeClusterId) ?? { b: [], r: [] }; g.r.push(r); clusters.set(r.workout.routeClusterId, g); }
    const adj = (r: ResearchRun) => Math.log(r.paceSecondsPerMile) - slope * (hr(r) - 150);
    const per = [...clusters.values()].filter(g => g.b.length >= 2 && g.r.length >= 2).map(g => median(g.r.map(adj)) - median(g.b.map(adj)));
    rows.push({ id: "same-route-hr-adjusted", status: per.length >= 2 ? "available" : "insufficient",
      reason: per.length >= 2 ? "ok" : "Fewer than 2 route clusters with >=2 runs in each period.",
      sample: { qualifyingClusters: per.length, clusters: clusters.size }, contrastPercent: per.length >= 2 ? (Math.exp(median(per)) - 1) * 100 : null, finishSeconds: null });

    // Multiweek efficiency: weekly median EF over the 12 weeks to yesterday; Theil-Sen trend of weekly medians.
    const win = steady.filter(r => r.date >= shiftPerformanceDate(date, -84) && r.date <= shiftPerformanceDate(date, -1));
    const byWeek = new Map<string, number[]>();
    for (const r of win) byWeek.set(monday(r.date), [...(byWeek.get(monday(r.date)) ?? []), (3600 / r.paceSecondsPerMile) / hr(r)]);
    const wk = [...byWeek.entries()].filter(([, v]) => v.length >= 2).sort(([a], [b]) => a.localeCompare(b));
    const efOk = wk.length >= 6;
    const sl = efOk ? theilSen(wk.map(([w]) => dayNum(w)), wk.map(([, v]) => median(v))) : null;
    const meanEf = efOk ? median(wk.map(([, v]) => median(v))) : NaN;
    rows.push({ id: "multiweek-efficiency", status: efOk ? "available" : "insufficient", reason: efOk ? "ok" : "Needs >=6 weeks with >=2 steady outdoor runs in the last 12 weeks.",
      sample: { weeksWithTwoRuns: wk.length, runs: win.length }, contrastPercent: null,
      trendPercentPer28d: sl !== null ? (sl * 28 / meanEf) * 100 : null, finishSeconds: null });
  }
  const sig = hrEnh.signal;
  rows.push({ id: "hr-enhanced-selected", status: hrEnh.status === "unavailable" ? "insufficient" : "available",
    reason: hrEnh.status === "unavailable" ? hrEnh.fallbackReason ?? "unavailable" : hrEnh.status === "no_change" ? (hrEnh.fallbackReason ?? "no change") : "ok",
    sample: { baselineRuns: sig?.counts.supported.baseline ?? 0, recentRuns: sig?.counts.supported.recent ?? 0, baselineWeeks: sig?.counts.weeks.baseline ?? 0, recentWeeks: sig?.counts.weeks.recent ?? 0 },
    contrastPercent: sig?.contrast.rawPercent ?? null, finishSeconds: hrEnh.candidateSeconds });
  return { asOf: input.asOf, anchorDate, rows };
}
export type { HealthWorkout };
