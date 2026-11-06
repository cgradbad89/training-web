import { toDate } from "./dates";
import type { WeatherSnapshot } from "@/types/weather";

function parseWeather(value: unknown): WeatherSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const tempF = num(r.tempF);
  const feelsLikeF = num(r.feelsLikeF);
  const humidity = num(r.humidity);
  const windMph = num(r.windMph);
  const dewPointF = num(r.dewPointF);
  const conditionCode = num(r.conditionCode);
  const conditionText =
    typeof r.conditionText === "string" ? r.conditionText : null;
  const fetchedAt = typeof r.fetchedAt === "string" ? r.fetchedAt : null;

  if (
    tempF === null ||
    feelsLikeF === null ||
    humidity === null ||
    windMph === null ||
    dewPointF === null ||
    conditionCode === null ||
    conditionText === null ||
    fetchedAt === null
  ) {
    return undefined;
  }

  return {
    tempF,
    feelsLikeF,
    humidity,
    windMph,
    dewPointF,
    conditionCode,
    conditionText,
    fetchedAt,
  };
}

/** Shared normalization for the current-estimate parent fields, without a database client. */
export function workoutModelSummary(id: string, data: Record<string, unknown>) {
  const displayType = (data.displayType as string) ?? "Workout";
  return {
    workoutId: (data.workoutId as string) ?? id,
    name: displayType,
    activityType: (data.activityType as string) ?? "",
    displayType,
    startDate: toDate(data.startDate),
    endDate: toDate(data.endDate),
    durationSeconds: (data.durationSeconds as number) ?? 0,
    sourceName: (data.sourceName as string) ?? "Apple Watch",
    isRunLike: (data.isRunLike as boolean) ?? false,
    hasRoute: (data.hasRoute as boolean) ?? false,
    hasHRStream: (data.hasHRStream as boolean) ?? false,
    // Manual documents use updatedAt and never write the iOS sync anchor.
    syncedAt: toDate(data.entrySource === "manual" ? data.updatedAt : data.syncedAt),
    avgHeartRate: (data.avgHeartRate as number | null) ?? null,
    distanceMiles: (data.distanceMiles as number) ?? 0,
    distanceMeters: (data.distanceMeters as number | null) ?? null,
    avgPaceSecPerMile: (data.avgPaceSecPerMile as number | null) ?? null,
    elevationGainM: (data.elevationGainM as number | null) ?? null,
    weather: parseWeather(data.weather),
    routeClusterId: typeof data.routeClusterId === "string" && data.routeClusterId.length > 0 ? data.routeClusterId : undefined,
  };
}
