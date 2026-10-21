import type { User } from "firebase/auth";
import type { Timestamp } from "firebase/firestore";
import type { EffectivePerformanceWorkout, PerformanceSnapshotPayload, WorkoutPerformanceFeature } from "./performanceAnalysis";

/** Obtained only from the current verified Firebase owner, never a UI-supplied UID. */
export interface PerformanceSession {
  readonly uid: string;
  readonly user: User;
  readonly sessionEpoch: number;
  readonly isSessionCurrent: (epoch: number) => boolean;
}

export interface PerformanceFeatureInput {
  feature: WorkoutPerformanceFeature;
  /** Dated verified extraction basis; matching parents do not verify later child state. */
  workout: EffectivePerformanceWorkout;
}

export interface StoredPerformanceFeature extends PerformanceFeatureInput {
  schemaVersion: 1;
  workoutId: string;
  revision: number;
  /** SHA-256 of feature + verified basis, excluding only the extraction clock. */
  featureDigest: string;
}

export interface PerformanceFeatureRevision {
  workoutId: string;
  revision: number;
  featureDigest: string;
}

export interface SavedPerformanceCurrent {
  schemaVersion: 1;
  revision: number;
  snapshotId: string;
  previousSnapshotId: string | null;
  /** Stable evidence/result identity, independent of actual calculation clock. */
  publicationDigest: string;
  payload: PerformanceSnapshotPayload;
  featureRevisions: PerformanceFeatureRevision[];
  committedAt: Timestamp | null;
}

export type SavedPerformanceSnapshot = SavedPerformanceCurrent;

export interface PerformancePublicationInput {
  payload: PerformanceSnapshotPayload;
  publicationDigest: string;
  expectedCurrentRevision: number | null;
  /** Complete saved feature set used to calculate this result. Rechecked in transaction. */
  features: readonly StoredPerformanceFeature[];
}

export interface PerformancePublicationResult {
  current: SavedPerformanceCurrent;
  snapshotCreated: boolean;
  documentsRead: number;
  documentsWritten: number;
}
