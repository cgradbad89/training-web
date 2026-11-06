import { checkpointSchedule, type Checkpoint } from "./checkpoint";
import { HORIZONS, checkpointKey, type Horizon, type Target } from "./evidence";
import { performanceLocalDate } from "@/utils/performanceEvidence";
import { captureObjectName, verifyCaptureGeneration, type CaptureStore } from "./scheduled-capture";

export type AuditStatus = "not_due" | "pending" | "verified" | "missed" | "unverified" | "unreadable";

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
export async function auditCaptures(target: Target, now: string, store: Pick<CaptureStore, "read">): Promise<AuditReport> {
  const today = performanceLocalDate(now, target.timeZone);
  const rows: AuditRow[] = [];
  const checkpoints: Checkpoint[] = [];
  const custody: AuditReport["custody"] = [];
  for (const horizon of HORIZONS) {
    const schedule = checkpointSchedule(target, horizon);
    const base = { horizon, ...schedule };
    const name = captureObjectName(checkpointKey(target, horizon));
    if (today < schedule.checkpointDate) { rows.push({ ...base, status: "not_due" }); continue; }
    let object;
    try {
      object = await store.read(name);
    } catch {
      rows.push({ ...base, status: "unreadable" });
      continue;
    }
    if (!object) { rows.push({ ...base, status: schedule.cutoff < now ? "missed" : "pending" }); continue; }
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
  const healthy = rows.every(row => row.status === "verified" || row.status === "pending" || row.status === "not_due");
  return { rows, checkpoints, custody, healthy };
}
