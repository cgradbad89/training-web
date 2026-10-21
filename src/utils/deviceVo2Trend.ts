import type {
  DeviceVo2Measurement,
  DeviceVo2Trend,
  PerformanceAnalysisInput,
  PerformanceWindow,
} from "@/types/performanceAnalysis";
import {
  canonicalizePerformanceValue,
  comparePerformanceKeys,
  isPerformanceDate,
  isPerformanceInstant,
  performanceComparisonWindows,
  performanceObservationWindow,
} from "@/utils/performanceEvidence";

type DeviceVo2Input = Pick<PerformanceAnalysisInput,
  "deviceVo2" | "asOf" | "timeZone" | "comparisonDays" | "observationDays" | "qualityPolicy">;

function inWindow(date: string, window: PerformanceWindow): boolean {
  return date >= window.startDate && date <= window.endDate;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function groupKey(measurement: DeviceVo2Measurement): string {
  return JSON.stringify([measurement.unit, measurement.sourceKind, measurement.sourceName]);
}

function deterministicOrder(a: DeviceVo2Measurement, b: DeviceVo2Measurement): number {
  return comparePerformanceKeys(a.date, b.date) || comparePerformanceKeys(groupKey(a), groupKey(b))
    || comparePerformanceKeys(a.measurementId, b.measurementId)
    || comparePerformanceKeys(canonicalizePerformanceValue(a.provenance), canonicalizePerformanceValue(b.provenance));
}

function copyMeasurement(measurement: DeviceVo2Measurement): DeviceVo2Measurement {
  return {
    measurementId: measurement.measurementId,
    date: measurement.date,
    value: measurement.value,
    unit: measurement.unit,
    sourceKind: measurement.sourceKind,
    sourceName: measurement.sourceName,
    availableAt: measurement.availableAt,
    provenance: {
      source: measurement.provenance.source,
      sourceId: measurement.provenance.sourceId,
      notes: [...measurement.provenance.notes],
    },
  };
}

/** Dated device estimates, kept separate from race performance and running VDOT. */
export function summarizeDeviceVo2(input: DeviceVo2Input): DeviceVo2Trend {
  if (!Number.isInteger(input.observationDays) || input.observationDays < 1 || input.observationDays > 180) {
    throw new Error("observationDays must be an integer from 1 to 180");
  }
  if (!Number.isInteger(input.qualityPolicy.minimumIndependentWorkouts) || input.qualityPolicy.minimumIndependentWorkouts < 1) {
    throw new Error("minimumIndependentWorkouts must be a positive integer");
  }
  const scope = performanceObservationWindow(input.asOf, input.timeZone, input.observationDays);
  const { currentWindow, referenceWindow } = performanceComparisonWindows(input.asOf, input.timeZone, input.comparisonDays);
  const cutoff = Date.parse(input.asOf);
  const limitations = new Set<string>([
    "Device VO2 estimates are not measured laboratory VO2 or race VDOT and are not converted into race times.",
    "Device estimates may share pace and HR inputs with running observations; they are not independent validation.",
    "Minimum date counts are descriptive policy thresholds, not validated precision or accuracy guarantees.",
  ]);
  const candidatesByDay = new Map<string, DeviceVo2Measurement[]>();
  for (const measurement of input.deviceVo2) {
    if (!isPerformanceDate(measurement.date) || !Number.isFinite(measurement.value) || measurement.value <= 0
      || !["ml/kg/min", "unknown"].includes(measurement.unit)
      || !["device_estimate", "unknown"].includes(measurement.sourceKind)) {
      limitations.add("Invalid VO2 dates, values, or source metadata were excluded.");
      continue;
    }
    if (!inWindow(measurement.date, scope)) continue;
    if (measurement.availableAt !== null) {
      if (!isPerformanceInstant(measurement.availableAt)) {
        limitations.add("VO2 measurements with invalid availability timestamps were excluded.");
        continue;
      }
      if (Date.parse(measurement.availableAt) > cutoff) {
        limitations.add("VO2 measurements known to become available after the as-of instant were excluded.");
        continue;
      }
    } else {
      limitations.add("Some VO2 availability times are unknown; their availability in a historical calculation cannot be verified.");
    }
    const key = JSON.stringify([groupKey(measurement), measurement.date]);
    const candidates = candidatesByDay.get(key) ?? [];
    candidates.push(measurement);
    candidatesByDay.set(key, candidates);
  }

  const measurements: DeviceVo2Measurement[] = [];
  for (const candidates of candidatesByDay.values()) {
    let resolved: DeviceVo2Measurement | undefined;
    if (new Set(candidates.map((candidate) => candidate.value)).size === 1) {
      resolved = [...candidates].sort((a, b) => {
        const availability = (b.availableAt === null ? -Infinity : Date.parse(b.availableAt))
          - (a.availableAt === null ? -Infinity : Date.parse(a.availableAt));
        return (Number.isNaN(availability) ? 0 : availability) || deterministicOrder(a, b);
      })[0];
    } else if (candidates.every((candidate) => candidate.availableAt !== null)) {
      const latestAvailability = Math.max(...candidates.map((candidate) => Date.parse(candidate.availableAt!)));
      const latest = candidates.filter((candidate) => Date.parse(candidate.availableAt!) === latestAvailability);
      if (new Set(latest.map((candidate) => candidate.value)).size === 1) {
        resolved = [...latest].sort(deterministicOrder)[0];
        limitations.add("Same-date VO2 corrections were resolved using known availability order.");
      }
    }
    if (resolved) measurements.push(copyMeasurement(resolved));
    else limitations.add("Conflicting same-date VO2 values with unresolved correction order were excluded.");
  }
  measurements.sort(deterministicOrder);

  const byGroup = new Map<string, DeviceVo2Measurement[]>();
  for (const measurement of measurements) {
    const key = groupKey(measurement);
    const group = byGroup.get(key) ?? [];
    group.push(measurement);
    byGroup.set(key, group);
    if (measurement.unit === "unknown" || measurement.sourceKind === "unknown" || !measurement.sourceName?.trim()) {
      limitations.add("Unknown units or source identity prevent a verified comparable-source VO2 trend.");
    }
    for (const note of measurement.provenance.notes) limitations.add(note);
  }
  const groups: DeviceVo2Trend["groups"][number][] = [...byGroup.entries()]
    .sort(([a], [b]) => comparePerformanceKeys(a, b))
    .map(([, measurements]) => {
      const first = measurements[0];
      const current = measurements.filter((measurement) => inWindow(measurement.date, currentWindow));
      const reference = measurements.filter((measurement) => inWindow(measurement.date, referenceWindow));
      const currentMedian = median(current.map((measurement) => measurement.value));
      const referenceMedian = median(reference.map((measurement) => measurement.value));
      const comparable = first.unit !== "unknown" && first.sourceKind === "device_estimate"
        && Boolean(first.sourceName?.trim());
      const enoughDates = current.length >= input.qualityPolicy.minimumIndependentWorkouts
        && reference.length >= input.qualityPolicy.minimumIndependentWorkouts;
      const change = comparable && enoughDates && currentMedian !== null && referenceMedian !== null
        ? currentMedian - referenceMedian : null;
      return {
        unit: first.unit,
        sourceKind: first.sourceKind,
        sourceName: first.sourceName,
        currentDates: current.length,
        referenceDates: reference.length,
        currentMedian,
        referenceMedian,
        change,
        status: change === null ? "insufficient" : "descriptive",
      };
    });
  if (measurements.length === 0) limitations.add("No eligible device VO2 measurements were supplied in the observation window.");
  if (!groups.some((group) => group.status === "descriptive")) {
    limitations.add("Insufficient comparable independent measurement dates for a VO2 trend.");
  }
  const latest = [...measurements].sort((a, b) => comparePerformanceKeys(b.date, a.date)
    || comparePerformanceKeys(groupKey(a), groupKey(b)) || comparePerformanceKeys(a.measurementId, b.measurementId))[0] ?? null;
  return {
    status: groups.some((group) => group.status === "descriptive") ? "descriptive" : "insufficient",
    currentWindow,
    referenceWindow,
    measurementDateCount: new Set(measurements.map((measurement) => measurement.date)).size,
    latest,
    groups,
    measurements,
    limitations: [...limitations].sort(),
  };
}
