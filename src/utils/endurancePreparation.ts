import type {
  CoverageState,
  EffectivePerformanceWorkout,
  EndurancePreparation,
  PerformanceAnalysisInput,
  PerformanceWindow,
} from "@/types/performanceAnalysis";
import {
  comparePerformanceKeys,
  isPerformanceDate,
  isPerformanceInstant,
  performanceLocalDate,
  performanceObservationWindow,
  shiftPerformanceDate,
} from "@/utils/performanceEvidence";

type PreparationInput = Pick<PerformanceAnalysisInput,
  "workouts" | "asOf" | "timeZone" | "coverage" | "observationDays" | "longRunDefinitionMeters">;

interface DatedRun {
  source: EffectivePerformanceWorkout;
  date: string;
  meters: number;
  seconds: number;
}

function inWindow(date: string, window: PerformanceWindow): boolean {
  return date >= window.startDate && date <= window.endDate;
}

function monday(date: string): string {
  // UTC is used only for arithmetic on an already resolved local calendar date.
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return shiftPerformanceDate(date, -((weekday + 6) % 7));
}

function numberOfDays(window: PerformanceWindow): number {
  return (Date.parse(`${window.endDate}T00:00:00Z`)
    - Date.parse(`${window.startDate}T00:00:00Z`)) / 86_400_000 + 1;
}

function contentKey(workout: EffectivePerformanceWorkout): string {
  return JSON.stringify([
    workout.parentDigest, workout.startedAt, workout.endedAt, workout.availableAt,
    workout.completion, workout.excluded, workout.isRun,
    workout.distanceMeters, workout.durationSeconds,
  ]);
}

/** Actual completed-run exposure. Telemetry quality is deliberately independent. */
export function summarizeEndurancePreparation(input: PreparationInput): EndurancePreparation {
  if (!Number.isFinite(input.longRunDefinitionMeters) || input.longRunDefinitionMeters <= 0) {
    throw new Error("longRunDefinitionMeters must be positive and finite");
  }
  if (!Number.isInteger(input.observationDays) || input.observationDays < 1 || input.observationDays > 180) {
    throw new Error("observationDays must be an integer from 1 to 180");
  }
  if (!isPerformanceDate(input.coverage.window.startDate) || !isPerformanceDate(input.coverage.window.endDate)
    || input.coverage.window.startDate > input.coverage.window.endDate) {
    throw new Error("Preparation coverage requires a valid date window");
  }
  const scope = performanceObservationWindow(input.asOf, input.timeZone, input.observationDays);
  const recentWindow = {
    startDate: [scope.startDate, shiftPerformanceDate(scope.endDate, -27)].sort().at(-1)!,
    endDate: scope.endDate,
  };
  const longRunWindow = {
    startDate: [scope.startDate, shiftPerformanceDate(scope.endDate, -55)].sort().at(-1)!,
    endDate: scope.endDate,
  };
  const cutoff = Date.parse(input.asOf);
  const limitations = new Set<string>([
    "Preparation describes recorded running exposure; it does not estimate race time or readiness.",
    "The long-run distance threshold is a descriptive policy choice, not a validated physiological cutoff.",
  ]);
  const byId = new Map<string, EffectivePerformanceWorkout[]>();
  for (const workout of input.workouts) {
    const entries = byId.get(workout.workoutId) ?? [];
    entries.push(workout);
    byId.set(workout.workoutId, entries);
  }
  const runs: DatedRun[] = [];
  const uncertainDates = new Set<string>();
  for (const entries of byId.values()) {
    const source = entries[0];
    if (new Set(entries.map(contentKey)).size !== 1) {
      limitations.add("Conflicting records for one workout were excluded rather than counted twice.");
      for (const entry of entries) {
        if (entry.isRun && !entry.excluded && isPerformanceInstant(entry.startedAt)) {
          uncertainDates.add(performanceLocalDate(entry.startedAt, input.timeZone));
        }
      }
      continue;
    }
    if (source.excluded || !source.isRun) continue;
    if (!isPerformanceInstant(source.startedAt) || !isPerformanceInstant(source.endedAt)) {
      limitations.add("Invalid workout timestamps were excluded; complete preparation coverage cannot be established.");
      // Its local date is unresolvable, so no window can certify a zero from this input set.
      uncertainDates.add("unknown");
      continue;
    }
    const date = performanceLocalDate(source.startedAt, input.timeZone);
    if (!inWindow(date, scope) || Date.parse(source.endedAt) > cutoff) continue;
    if (source.availableAt !== null && (!isPerformanceInstant(source.availableAt) || Date.parse(source.availableAt) > cutoff)) {
      limitations.add("Workouts with invalid or later-than-cutoff availability were excluded.");
      if (!isPerformanceInstant(source.availableAt)) uncertainDates.add(date);
      continue;
    }
    if (source.completion !== "completed" || Date.parse(source.endedAt) <= Date.parse(source.startedAt)
      || typeof source.distanceMeters !== "number" || !Number.isFinite(source.distanceMeters) || source.distanceMeters <= 0
      || typeof source.durationSeconds !== "number" || !Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0) {
      limitations.add("Incomplete, unresolved, or invalid running summaries were excluded.");
      uncertainDates.add(date);
      continue;
    }
    if (source.availableAt === null) {
      limitations.add("Some workout availability times are unknown; prior availability cannot be verified.");
    }
    for (const entry of entries) {
      for (const limitation of entry.limitations) limitations.add(limitation);
    }
    runs.push({ source, date, meters: source.distanceMeters, seconds: source.durationSeconds });
  }
  runs.sort((a, b) => comparePerformanceKeys(a.source.startedAt, b.source.startedAt)
    || comparePerformanceKeys(a.source.workoutId, b.source.workoutId));

  function coverageFor(window: PerformanceWindow): CoverageState {
    const intersects = input.coverage.window.startDate <= window.endDate
      && input.coverage.window.endDate >= window.startDate;
    if (!intersects || input.coverage.workouts === "unknown") return "unknown";
    const hasUncertainSummary = uncertainDates.has("unknown")
      || [...uncertainDates].some((date) => inWindow(date, window));
    return input.coverage.workouts === "complete"
      && input.coverage.window.startDate <= window.startDate
      && input.coverage.window.endDate >= window.endDate
      && !hasUncertainSummary ? "complete" : "partial";
  }

  function summarize(window: PerformanceWindow) {
    const selected = runs.filter((run) => inWindow(run.date, window));
    const coverage = coverageFor(window);
    const known = selected.length > 0 || coverage === "complete";
    return {
      selected,
      coverage,
      meters: known ? selected.reduce((sum, run) => sum + run.meters, 0) : null,
      seconds: known ? selected.reduce((sum, run) => sum + run.seconds, 0) : null,
      runCount: known ? selected.length : null,
      runDays: known ? new Set(selected.map((run) => run.date)).size : null,
    };
  }

  const recent = summarize(recentWindow);
  const longRuns = summarize(longRunWindow);
  const longRunCount = longRuns.selected.filter((run) => run.meters >= input.longRunDefinitionMeters).length;
  const longest = [...recent.selected].sort((a, b) => b.meters - a.meters
    || comparePerformanceKeys(a.source.startedAt, b.source.startedAt)
    || comparePerformanceKeys(a.source.workoutId, b.source.workoutId))[0] ?? null;
  const weekly: EndurancePreparation["weekly"][number][] = [];
  for (let weekStart = monday(scope.startDate); weekStart <= scope.endDate; weekStart = shiftPerformanceDate(weekStart, 7)) {
    const sunday = shiftPerformanceDate(weekStart, 6);
    const window = {
      startDate: weekStart < scope.startDate ? scope.startDate : weekStart,
      endDate: sunday > scope.endDate ? scope.endDate : sunday,
    };
    const summary = summarize(window);
    weekly.push({
      weekStart,
      window,
      meters: summary.meters,
      miles: summary.meters === null ? null : summary.meters / 1609.344,
      runCount: summary.runCount,
      runDays: summary.runDays,
      coverage: summary.coverage,
      partialWeek: window.startDate !== weekStart || window.endDate !== sunday || window.endDate === scope.endDate,
    });
  }
  const completeWeeks = weekly.filter((week) => !week.partialWeek && week.coverage === "complete");
  const weeksWithRuns = completeWeeks.filter((week) => (week.runCount ?? 0) > 0).length;
  if (coverageFor(scope) !== "complete") {
    limitations.add("Workout coverage is incomplete or unknown; positive totals are observed minimums and unverified empty windows remain null.");
  }
  if (weekly.some((week) => week.partialWeek)) {
    limitations.add("Edge weeks and the week containing the as-of instant are partial; consistency uses only complete observed weeks.");
  }
  for (const limitation of input.coverage.limitations) limitations.add(limitation);
  return {
    recentWindow,
    longRunWindow,
    longRunDefinitionMeters: input.longRunDefinitionMeters,
    recent: {
      meters: recent.meters,
      seconds: recent.seconds,
      runCount: recent.runCount,
      runDays: recent.runDays,
      runsPerWeek: recent.runCount === null ? null : recent.runCount * 7 / numberOfDays(recentWindow),
    },
    longestRecentRun: longest === null ? null : {
      workoutId: longest.source.workoutId, date: longest.date, meters: longest.meters, seconds: longest.seconds,
    },
    longRunCount: longRunCount > 0 || longRuns.coverage === "complete" ? longRunCount : null,
    weekly,
    consistency: {
      completeWeeks: completeWeeks.length,
      weeksWithRuns,
      fraction: completeWeeks.length > 0 ? weeksWithRuns / completeWeeks.length : null,
    },
    limitations: [...limitations].sort(),
  };
}
