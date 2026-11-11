/**
 * Plan document normalization (pure — no Firebase client import).
 *
 * Extracted verbatim from `fetchPlans`/`fetchPlan` so the browser service and
 * the server-side Hub reader map a raw `users/{uid}/plans/{planId}` document
 * identically:
 *  - `planType` defaults to "running" (documents written before workout plans);
 *  - `status` is derived (explicit valid status wins, else the legacy `isActive`);
 *  - `isActive` is re-derived from the resolved status;
 *  - `startDate` is normalized to its date-only string and `createdAt` to ISO
 *    (both accept Firestore Timestamps, Admin Timestamps, Dates or strings).
 */

import { derivePlanStatus, isActiveFromStatus, type Plan } from "@/types/plan";
import { toDate } from "@/utils/dates";

export function normalizePlanDocument(id: string, data: Record<string, unknown>): Plan {
  const planType = (data.planType as string | undefined) ?? "running";
  const status = derivePlanStatus(data);
  return {
    ...data,
    id,
    planType,
    status,
    isActive: isActiveFromStatus(status),
    startDate: toDate(data.startDate).toISOString().split("T")[0],
    createdAt: toDate(data.createdAt).toISOString(),
  } as Plan;
}
