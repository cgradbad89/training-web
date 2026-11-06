import { checkpointSchedule, type Checkpoint } from "./checkpoint";
import { HORIZONS, checkpointKey, instant, type Horizon, type Target } from "./evidence";
import { performanceLocalDate } from "@/utils/performanceEvidence";
import { captureObjectName, verifyCaptureGeneration, type CaptureStore } from "./scheduled-capture";

export type AuditStatus = "not_due" | "pending" | "verified" | "missed" | "unverified" | "unreadable"
  /** The slot ended before the race was first tracked. Never a miss, and never backfilled. */
  | "not_enrolled"
  /** Tracking was canceled (owner deactivated or removed the race) before the slot ended. Existing evidence is still verified. */
  | "canceled";

export interface AuditOptions {
  /** ISO instant tracking began. Slots whose cutoff is not after it are `not_enrolled`. Omit for the pinned race (strict). */
  enrolledFrom?: string;
  /** ISO instant tracking stopped. Slots still open then, with no object, are `canceled`. */
  canceledAt?: string;
}

export interface AuditRow {
  horizon: Horizon;
  checkpointDate: string;
  cutoff: string;
  status: AuditStatus;
  generation?: string;
  createdAt?: string;
}

export interface AuditReport {
  rows: AuditRow[];
  /** Replayed, digest-verified artifacts and their independent generation receipts, ready for the Phase 3D study. */
  checkpoints: Checkpoint[];
  custody: { kind: "checkpoint"; digest: string; anchoredAt: string; reference: string }[];
  /** True when every slot whose cutoff has passed has a verified receipt. */
  healthy: boolean;
}

/**
 * Read-only audit using the verifier identity: never writes, never reads Firestore. A missing slot after its
 * cutoff is reported as missed, never reconstructed.
 */
export async function auditCaptures(target: Target, now: string, store: Pick<CaptureStore, "read">, options: AuditOptions = {}): Promise<AuditReport> {
  const enrolledFrom = options.enrolledFrom === undefined ? undefined : instant(options.enrolledFrom, "enrolledFrom");
  const canceledAt = options.canceledAt === undefined ? undefined : instant(options.canceledAt, "canceledAt");
  const today = performanceLocalDate(now, target.timeZone);
  const rows: AuditRow[] = [];
  const checkpoints: Checkpoint[] = [];
  const custody: AuditReport["custody"] = [];
  for (const horizon of HORIZONS) {
    const schedule = checkpointSchedule(target, horizon);
    const base = { horizon, ...schedule };
    const name = captureObjectName(checkpointKey(target, horizon));
    // Evidence always wins: a stored object is verified even for a canceled or late-enrolled race.
    let object;
    if (today >= schedule.checkpointDate) {
      try {
        object = await store.read(name);
      } catch {
        rows.push({ ...base, status: "unreadable" });
        continue;
      }
    }
    if (!object) {
      if (enrolledFrom !== undefined && schedule.cutoff <= enrolledFrom) rows.push({ ...base, status: "not_enrolled" });
      else if (canceledAt !== undefined && canceledAt <= schedule.cutoff) rows.push({ ...base, status: "canceled" });
      else if (today < schedule.checkpointDate) rows.push({ ...base, status: "not_due" });
      else rows.push({ ...base, status: schedule.cutoff < now ? "missed" : "pending" });
      continue;
    }
    try {
      const { checkpoint, custody: receipt } = verifyCaptureGeneration(object,
        { key: checkpointKey(target, horizon), target, horizon, ...schedule }, now, name);
      checkpoints.push(checkpoint);
      custody.push(receipt);
      rows.push({ ...base, status: "verified", generation: object.generation, createdAt: object.createdAt });
    } catch {
      rows.push({ ...base, status: "unverified", generation: object.generation, createdAt: object.createdAt });
    }
  }
  const healthy = rows.every(row => ["verified", "pending", "not_due", "not_enrolled", "canceled"].includes(row.status));
  return { rows, checkpoints, custody, healthy };
}

/** Audit every tracked race independently. One race's problems never mask or erase another race's evidence. */
export async function auditEnrolledCaptures(
  enrollments: readonly { target: Target; options?: AuditOptions }[], now: string, store: Pick<CaptureStore, "read">,
) {
  const reports = [];
  for (const { target, options } of enrollments) reports.push({ target, report: await auditCaptures(target, now, store, options) });
  return { reports, healthy: reports.every(entry => entry.report.healthy) };
}
