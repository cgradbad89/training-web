/**
 * Bounded read-only Firestore fetchers behind the hybrid v1.1 physiological stores (`physiologyEvidenceStores.ts`).
 * No writes. No new collection, no new composite index: both queries reuse the single-field shapes the app already runs.
 *
 *  - VO₂: `users/{uid}/healthMetrics` where date >= cutoff orderBy date — the SAME shape and `buildVo2History` filtering as the
 *    personal-insights VO₂ history (`useAggregatedStats`), over a 70-day window (two 28-day comparison windows plus margin) instead
 *    of 180 days. `vo2_max > 0` stays a client-side filter.
 *  - HR streams: `users/{uid}/healthWorkouts/{id}/hrStream` ordered by chunkIndex with `limit(maxChunks)`; the cross-repo document
 *    contract in `services/hrStream.ts` is not altered.
 */
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { HrSample } from "@/types/hybridPerformance";
import { buildVo2History, vo2HistoryCutoffISO } from "@/utils/vo2History";
import { PHYSIOLOGY_LIMITS } from "./physiologyEvidenceStores";

export async function fetchVo2EvidenceWindow(uid: string, now: Date): Promise<{ entries: ReturnType<typeof buildVo2History>; docsRead: number }> {
  const cutoff = vo2HistoryCutoffISO(now, PHYSIOLOGY_LIMITS.vo2WindowDays);
  const snap = await getDocs(query(collection(db, `users/${uid}/healthMetrics`), where("date", ">=", cutoff), orderBy("date")));
  const entries = buildVo2History(snap.docs.map(d => ({ id: d.id, data: d.data() as { date?: string; vo2_max?: number } })));
  return { entries, docsRead: snap.size };
}

interface RawSample { t?: { toDate?: () => Date } | null; hr?: number }

export async function fetchHrStreamBounded(uid: string, workoutId: string, maxChunks: number): Promise<{ samples: HrSample[]; chunks: number }> {
  const snap = await getDocs(query(collection(db, "users", uid, "healthWorkouts", workoutId, "hrStream"), orderBy("chunkIndex", "asc"), limit(maxChunks)));
  const raw: { ms: number; bpm: number }[] = [];
  for (const d of snap.docs) {
    const samples = (d.data() as { samples?: RawSample[] }).samples;
    if (!Array.isArray(samples)) continue;
    for (const s of samples) {
      const ms = s.t?.toDate?.()?.getTime();
      if (typeof ms === "number" && Number.isFinite(ms) && typeof s.hr === "number") raw.push({ ms, bpm: s.hr });
    }
  }
  const t0 = raw.length ? Math.min(...raw.map(r => r.ms)) : 0;
  return { samples: raw.map(r => ({ t: (r.ms - t0) / 1000, bpm: r.bpm })), chunks: snap.size };
}
