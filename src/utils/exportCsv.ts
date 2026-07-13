import { type HealthWorkout } from "@/types/healthWorkout";
import { type MileSplit } from "@/utils/mileSplits";
import { resolveDisplayLoad } from "@/utils/trainingLoad";
import { formatPace, formatDuration } from "@/utils/pace";

export type TimeRange = "30_days" | "90_days" | "6_months" | "ytd" | "all_time";

export function filterByTimeRange(
  workouts: HealthWorkout[],
  range: TimeRange
): HealthWorkout[] {
  if (range === "all_time") return workouts;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let startDate = new Date(0); // Epoch start

  switch (range) {
    case "30_days":
      startDate = new Date(startOfDay.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "90_days":
      startDate = new Date(startOfDay.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case "6_months":
      startDate = new Date(startOfDay.getTime() - 180 * 24 * 60 * 60 * 1000);
      break;
    case "ytd":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
  }

  return workouts.filter((w) => w.startDate >= startDate);
}

function escapeCsvField(field: string | number | null | undefined): string {
  if (field === null || field === undefined) return "";
  const str = String(field);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateWorkoutsCsv(
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number
): string {
  const headers = [
    "Date",
    "Workout Type",
    "Name",
    "Time",
    "Calories",
    "Avg BPM",
    "Load",
  ];

  const rows = workouts.map((w) => {
    const load = resolveDisplayLoad(w, maxHr, restingHr);
    return [
      w.startDate.toISOString(),
      w.displayType,
      w.name,
      formatDuration(w.durationSeconds),
      Math.round(w.calories),
      w.avgHeartRate ? Math.round(w.avgHeartRate) : "",
      load !== null ? Math.round(load) : "",
    ];
  });

  const csvContent = [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCsvField).join(",")),
  ].join("\n");

  return csvContent;
}

export function generateRunsCsv(
  runs: HealthWorkout[],
  splitsMap: Record<string, MileSplit[]>,
  maxHr: number,
  restingHr: number
): string {
  let maxSplitsCount = 0;
  runs.forEach((run) => {
    const splits = splitsMap[run.workoutId] || [];
    if (splits.length > maxSplitsCount) {
      maxSplitsCount = splits.length;
    }
  });

  const baseHeaders = [
    "Date",
    "Distance (mi)",
    "Avg Pace",
    "Calories",
    "Avg BPM",
    "Training Load",
    "Temp (F)",
    "Humidity (%)",
  ];

  const splitHeaders: string[] = [];
  for (let i = 1; i <= maxSplitsCount; i++) {
    splitHeaders.push(`Mile Split ${i} Pace`);
    splitHeaders.push(`Mile Split ${i} Avg BPM`);
  }

  const headers = [...baseHeaders, ...splitHeaders];

  const rows = runs.map((run) => {
    const load = resolveDisplayLoad(run, maxHr, restingHr);
    const splits = splitsMap[run.workoutId] || [];
    
    const splitColumns: string[] = [];
    for (let i = 0; i < maxSplitsCount; i++) {
      if (i < splits.length) {
        const split = splits[i];
        const pace = formatPace(split.paceSecPerMile);
        const hr = split.avgBpm ? Math.round(split.avgBpm).toString() : "";
        // If it's a partial mile, we'll include the distance so it's clear
        const paceStr = split.isPartial ? `${pace} (${split.segmentMiles.toFixed(2)}mi)` : pace;
        splitColumns.push(paceStr);
        splitColumns.push(hr);
      } else {
        splitColumns.push("");
        splitColumns.push("");
      }
    }

    return [
      run.startDate.toISOString(),
      run.distanceMiles.toFixed(2),
      run.avgPaceSecPerMile ? formatPace(run.avgPaceSecPerMile) : "",
      Math.round(run.calories),
      run.avgHeartRate ? Math.round(run.avgHeartRate) : "",
      load !== null ? Math.round(load) : "",
      run.weather?.tempF ?? "",
      run.weather?.humidity ?? "",
      ...splitColumns,
    ];
  });

  const csvContent = [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCsvField).join(",")),
  ].join("\n");

  return csvContent;
}

export function downloadCsv(filename: string, csvContent: string) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
