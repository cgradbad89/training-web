/**
 * Hub summary contract — a COPY of the my-hub envelope and Training types
 * (my-hub: src/lib/hub-contract.ts), narrowed to this app. Keep the shapes in
 * sync with the hub by hand; the hub is the source of truth. Mirrors the
 * approach budget-web used.
 */

export type AppId = "training";

export type HubSummary<T> =
  | {
      status: "ok";
      app: AppId;
      generatedAt: string;
      periodLabel: string;
      appUrl: string;
      data: T;
    }
  | {
      status: "unavailable";
      app: AppId;
      generatedAt: string;
      reason: string;
    };

type SevenDays<T> = [T, T, T, T, T, T, T];

export interface TrainingData {
  days: SevenDays<{
    date: string;
    planned?: string;
    /**
     * Planned run miles for this day: sum of `distanceMiles` of the active
     * running plan's non-rest entries dated this day. 0 when none. (Additive,
     * for Hub Glance.)
     */
    targetMiles: number;
    completed: { type: string; miles?: number }[];
  }>;
  totals: { runs: number; miles: number; workouts: number };
  planned: { runs: number; miles: number; workouts: number };
  /**
   * The race being trained for: the goal race (`isActive`) when it is today or
   * later, otherwise the soonest upcoming race; null when no race is upcoming.
   * `daysRemaining` counts Eastern civil days (0 = race day). (Additive, for Hub Glance.)
   */
  race: HubRace | null;
}

export interface HubRace {
  name: string;
  /** Race day, "YYYY-MM-DD". */
  date: string;
  /** "5K", "10K", "Half Marathon", "Marathon", or "<n> mi" for a custom distance. */
  distance: string;
  daysRemaining: number;
}

/** Where the hub's Training tile links to. */
export const TRAINING_APP_URL = "https://training-web-rho.vercel.app/dashboard";
