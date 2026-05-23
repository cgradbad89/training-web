/**
 * Training Load — daily time series + rolling aggregates.
 *
 * Pure helpers (no React, no Firestore). Built so the dashboard's new
 * "Load Score Training Load" card and Personal Insights can share one
 * source of truth for daily / rolling TRIMP-style load.
 *
 * Status thresholds and labels mirror the existing mileage-based load card
 * (see src/utils/metrics.ts → trainingLoadLevel), so both cards on the
 * dashboard speak the same language.
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import { computeTrainingLoad } from "@/utils/trainingLoad";
import { trainingLoadLevel, type TrainingLoadLevel } from "@/utils/metrics";

export interface DailyLoad {
  runLoad: number;
  workoutLoad: number;
  totalLoad: number;
}

/** YYYY-MM-DD from a Date using its local components. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse "YYYY-MM-DD" → local Date at 00:00. */
function parseLocalIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  return new Date(y, m - 1, d);
}

/**
 * Bucket a list of workouts into a daily-load map keyed by local YYYY-MM-DD.
 * Per workout, the TRIMP-style score is computed via computeTrainingLoad();
 * null results (missing HR / duration) are skipped — NOT counted as 0.
 *
 * Runs (isRunLike) accumulate into runLoad; everything else into workoutLoad.
 * totalLoad is the sum of both.
 */
export function buildDailyLoadMap(
  workouts: HealthWorkout[]
): Map<string, DailyLoad> {
  const map = new Map<string, DailyLoad>();

  for (const w of workouts) {
    const score = computeTrainingLoad(
      w.durationSeconds,
      w.avgHeartRate,
      w.activityType
    );
    if (score == null) continue;

    const key = toLocalIsoDate(w.startDate);
    const entry =
      map.get(key) ?? { runLoad: 0, workoutLoad: 0, totalLoad: 0 };

    if (w.isRunLike) {
      entry.runLoad += score;
    } else {
      entry.workoutLoad += score;
    }
    entry.totalLoad += score;

    map.set(key, entry);
  }

  return map;
}

/**
 * Sum totalLoad over the trailing `windowDays` ending on `endDate` (inclusive).
 *
 * Window semantics mirror the existing mileage card: `cutoff = endDate −
 * windowDays`, then any daily entry with date ≥ cutoff and ≤ endDate counts.
 */
export function rollingLoad(
  dailyMap: Map<string, DailyLoad>,
  endDate: Date,
  windowDays: number
): number {
  const cutoff = new Date(endDate);
  cutoff.setDate(endDate.getDate() - windowDays);

  let total = 0;
  for (const [iso, entry] of dailyMap) {
    const d = parseLocalIsoDate(iso);
    if (d >= cutoff && d <= endDate) {
      total += entry.totalLoad;
    }
  }
  return total;
}

export type LoadStatusLevel = "low" | "neutral" | "high";

export interface LoadStatus {
  label: string;
  level: LoadStatusLevel;
}

/**
 * Map the 4 existing mileage-card load tiers (recovery/stable/building/high)
 * onto the 3-tier badge palette this card uses.
 *
 * Labels are preserved verbatim from the mileage card so both cards on the
 * dashboard read identically.
 */
const STATUS_FOR_LEVEL: Record<TrainingLoadLevel, LoadStatus> = {
  deload:     { label: "Recovery",  level: "low"     },
  stable:     { label: "Stable",    level: "neutral" },
  building:   { label: "Building",  level: "neutral" },
  aggressive: { label: "High Load", level: "high"    },
};

/**
 * Map an acute/chronic weekly load pair to the same status taxonomy the
 * mileage-based card uses. Returns null when chronicWeekly ≤ 0 — the caller
 * should render "—" in that case (no baseline to compare against yet).
 */
export function loadStatus(
  acute: number,
  chronicWeekly: number
): LoadStatus | null {
  if (chronicWeekly <= 0) return null;
  const ratio = acute / chronicWeekly;
  return STATUS_FOR_LEVEL[trainingLoadLevel(ratio)];
}

// ─── EWMA fitness/fatigue series (PMC-style CTL / ATL / TSB) ────────────────
//
// Time constants follow the standard sports-science formulation:
//   CTL (Chronic Training Load) ≈ 42-day exponentially weighted mean → fitness
//   ATL (Acute Training Load)   ≈  7-day exponentially weighted mean → fatigue
//   TSB (Training Stress Balance) = CTL − ATL                       → form
//
// The recursive form:
//   ema_today = ema_yesterday + (load_today − ema_yesterday) × α
//   α = 1 − exp(−1 / τ)         τ = time constant in days
// is equivalent to the canonical PMC formulas and lets us walk one day at a
// time, including rest days at load=0 so fatigue decays naturally.

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

export interface LoadEwmaPoint {
  /** Local YYYY-MM-DD. */
  date: string;
  /** Raw daily total training load for this date (0 on rest days). */
  load: number;
  /** Chronic / fitness EWMA, raw float — caller rounds for display. */
  ctl: number;
  /** Acute / fatigue EWMA, raw float. */
  atl: number;
  /** Same-day Form: ctl − atl. (Some implementations use yesterday's CTL/ATL;
   *  we use same-day for simplicity and immediacy.) */
  tsb: number;
}

/**
 * Walk every calendar day from startDate → endDate (inclusive, local-date
 * semantics) and produce an EWMA fitness/fatigue series. Missing days are
 * filled with load=0 so rest decays the EWMA the same way training builds it.
 *
 * Seed: ctl and atl start at 0 on day one. Callers needing a converged
 * baseline should pass an earlier startDate (≥ 3× CTL_DAYS before the window
 * of interest) and then slice the tail for display.
 */
export function buildLoadEwmaSeries(
  dailyMap: Map<string, DailyLoad>,
  startDate: Date,
  endDate: Date
): LoadEwmaPoint[] {
  const start = startOfLocalDay(startDate);
  const end = startOfLocalDay(endDate);
  if (end < start) return [];

  const alphaCtl = 1 - Math.exp(-1 / CTL_DAYS);
  const alphaAtl = 1 - Math.exp(-1 / ATL_DAYS);

  const series: LoadEwmaPoint[] = [];
  let ctl = 0;
  let atl = 0;

  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = toLocalIsoDate(cursor);
    const load = dailyMap.get(iso)?.totalLoad ?? 0;

    ctl = ctl + (load - ctl) * alphaCtl;
    atl = atl + (load - atl) * alphaAtl;
    const tsb = ctl - atl;

    series.push({ date: iso, load, ctl, atl, tsb });

    cursor.setDate(cursor.getDate() + 1);
  }

  return series;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
