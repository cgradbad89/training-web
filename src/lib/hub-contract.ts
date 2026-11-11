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
    completed: { type: string; miles?: number }[];
  }>;
  totals: { runs: number; miles: number; workouts: number };
  planned: { runs: number; miles: number; workouts: number };
}

/** Where the hub's Training tile links to. */
export const TRAINING_APP_URL = "https://training-web-rho.vercel.app/dashboard";
