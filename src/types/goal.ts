import { type Timestamp } from "firebase/firestore";

/**
 * RunningGoal — mirrors the Firestore document stored at
 * users/{uid}/goals/{goalId}
 *
 * A user-defined distance/time/count target over a custom date range.
 * Soft-deleted goals keep their document with isActive = false.
 */

export type GoalMetric = "distance" | "time" | "count";

export interface RunningGoal {
  id: string;
  label: string;
  /** distance = miles, time = seconds, count = number of runs */
  metric: GoalMetric;
  target: number;
  /** ISO date 'YYYY-MM-DD' */
  startDate: string;
  /** ISO date 'YYYY-MM-DD' */
  endDate: string;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
