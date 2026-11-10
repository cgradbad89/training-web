import type { Firestore, QuerySnapshot } from 'firebase-admin/firestore';
import type { HealthWorkout } from '@/types/healthWorkout';
import type { WorkoutOverride } from '@/types/workoutOverride';
import { derivePlanStatus, isActiveFromStatus, type RunningPlan } from '@/types/plan';
import { workoutModelSummary } from '@/utils/workoutModelSummary';
import { parseStoredBestEfforts } from '@/utils/bestEfforts';
import { toDate } from '@/utils/dates';
import { normalizeRaceDocument } from '@/utils/raceDocument';
import { isPerformanceDate, shiftPerformanceDate } from '@/utils/performanceEvidence';
import { raceEvaluationCutoff } from '@/utils/racePerformanceEvaluation';
import { buildVo2History } from '@/utils/vo2History';
import { selectResearchRuns } from '@/utils/workoutRaceResearch';
import { selectStreamCandidates } from '@/utils/performance/hrStreamSelection';
import { HrStreamEvidenceStore, PHYSIOLOGY_LIMITS } from '@/services/physiologyEvidenceStores';
import { WORKOUT_FIELDS, RACE_FIELDS, OVERRIDE_FIELDS } from './capture-source';
import { digest, key } from './evidence';
import { reportingDate, scheduledRace, VALIDATION_TIME_ZONE, type ScheduledRace } from './prediction-schedule';
import type { PredictionInput } from './prediction-models';

export const VALIDATION_LIMITS = { workouts: 1000, races: 100, overrides: 1000, plans: 100, metrics: 100, activeRaces: 10 } as const;
const META_FIELDS = ['raceDate', 'raceDistance', 'customDistanceMiles', 'isActive', 'linkedPlanId', 'status', 'canceled', 'cancelled'];
export interface EvidenceUsage {
  documents: Record<string, number>; queryMinimumReads: number; firestoreWrites: 0;
}
export interface ValidationSource { input: PredictionInput; usage: EvidenceUsage; limitations: string[]; evidenceDigest: string; discovered: ScheduledRace[]; }
function ownerRef(db: Firestore, uid: string, projectId: string) {
  if (key(uid, 'ownerUid').includes('/') || (db as unknown as { projectId?: string }).projectId !== projectId) throw new Error('Invalid validation binding');
  return db.collection('users').doc(uid);
}

/** Minimal discovery only. Active flag is authoritative: cancel/delete/deactivate removes future enrollment. */
export function createValidationMetadataReader(db: Firestore, uid: string, projectId: string) {
  const owner = ownerRef(db, uid, projectId);
  return async () => {
    const snap = await owner.collection('halfMarathonRaces').where('isActive', '==', true).select(...META_FIELDS).limit(VALIDATION_LIMITS.activeRaces + 1).get();
    if (snap.size > VALIDATION_LIMITS.activeRaces) throw new Error('Active race discovery overflow');
    return { races: snap.docs.flatMap(d => { const race = scheduledRace({ ...d.data(), id: d.id }); return race ? [race] : []; }),
      documentsRead: snap.size, minimumReads: Math.max(1, snap.size) };
  };
}

/** Match the app's prediction-relevant parent normalization; never fetch route data. */
export function validationWorkout(id: string, data: Record<string, unknown>): HealthWorkout {
  return { ...workoutModelSummary(id, data),
    entrySource: data.entrySource === 'manual' ? 'manual' : undefined,
    updatedAt: data.entrySource === 'manual' && data.updatedAt ? toDate(data.updatedAt) : undefined,
    routeComplete: typeof data.routeComplete === 'boolean' ? data.routeComplete : undefined,
    bestEfforts: parseStoredBestEfforts(data.bestEfforts),
    calories: 0, avgSpeedMPS: null, hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null };
}

/** One read-only transaction for parents AND selected physiology; all observations were available at the same server timestamp. */
export function createValidationEvidenceReader(db: Firestore, uid: string, projectId: string) {
  const owner = ownerRef(db, uid, projectId);
  return async (now: string, hydrate: boolean): Promise<ValidationSource> => {
    const date = reportingDate(now), from = shiftPerformanceDate(date, -365);
    const first = new Date(Date.parse(raceEvaluationCutoff(from, VALIDATION_TIME_ZONE)) + 1);
    const documents: Record<string, number> = {}; let queryMinimumReads = 0;
    try { return await db.runTransaction(async tx => {
      const revisions: unknown[] = []; const limitations: string[] = [];
      let readTime: QuerySnapshot['readTime'] | undefined;
      const track = (name: string, snap: QuerySnapshot, bound: number) => {
        documents[name] = (documents[name] ?? 0) + snap.size;
        queryMinimumReads += Math.max(1, snap.size);
        if (snap.size > bound) throw new Error(`Evidence overflow: ${name}`); // never compute on a truncated parent set
        if (readTime && !snap.readTime.isEqual(readTime)) throw new Error('Inconsistent evidence read');
        readTime ??= snap.readTime;
        for (const d of snap.docs) {
          if (d.updateTime.toMillis() > snap.readTime.toMillis()) throw new Error('Post-cutoff revision');
          revisions.push([name, d.id, d.updateTime.seconds, d.updateTime.nanoseconds]);
        }
        return snap.docs;
      };
      const workouts = track('workouts', await tx.get(owner.collection('healthWorkouts').where('startDate', '>=', first)
        .orderBy('startDate', 'desc').select(...WORKOUT_FIELDS, 'routeComplete', 'bestEfforts').limit(VALIDATION_LIMITS.workouts + 1)), VALIDATION_LIMITS.workouts)
        .map(d => validationWorkout(d.id, d.data()));
      const races = track('races', await tx.get(owner.collection('halfMarathonRaces').select(...RACE_FIELDS, ...META_FIELDS)
        .limit(VALIDATION_LIMITS.races + 1)), VALIDATION_LIMITS.races).map(d => normalizeRaceDocument(d.id, d.data()));
      const overrides = Object.fromEntries(track('overrides', await tx.get(owner.collection('workoutOverrides').select(...OVERRIDE_FIELDS)
        .limit(VALIDATION_LIMITS.overrides + 1)), VALIDATION_LIMITS.overrides).map(d => [d.id, d.data() as WorkoutOverride]));
      const planRows = track('plans', await tx.get(owner.collection('plans').select('planType', 'startDate', 'weeks', 'status', 'isActive', 'createdAt', 'updatedAt')
        .limit(VALIDATION_LIMITS.plans + 1)), VALIDATION_LIMITS.plans);
      const asOf = readTime!.toDate().toISOString();
      const plans = planRows.flatMap(d => {
        const p = d.data();
        if ((p.planType && p.planType !== 'running') || !isPerformanceDate(p.startDate) || !Array.isArray(p.weeks)) return [];
        if (p.updatedAt && toDate(p.updatedAt).getTime() > Date.parse(asOf)) { limitations.push('plan_timestamp_after_capture'); return []; }
        const status = derivePlanStatus(p);
        return [{ ...p, id: d.id, name: '', status, isActive: isActiveFromStatus(status), planType: 'running',
          createdAt: toDate(p.createdAt).toISOString() } as RunningPlan];
      });
      const input: PredictionInput = { asOf, workouts, races, overrides, plans, options: { vo2Load: 'not_requested', streamLoad: 'not_requested' } };
      if (hydrate) {
        const metrics = track('metrics', await tx.get(owner.collection('healthMetrics')
          .where('date', '>=', shiftPerformanceDate(date, -PHYSIOLOGY_LIMITS.vo2WindowDays)).orderBy('date')
          .select('date', 'vo2_max').limit(VALIDATION_LIMITS.metrics + 1)), VALIDATION_LIMITS.metrics);
        input.options.vo2Entries = buildVo2History(metrics.map(d => ({ id: d.id, data: d.data() }))).filter(e => e.date <= date);
        input.options.vo2Load = 'loaded';
        const { runs } = selectResearchRuns({ ...input, timeZone: VALIDATION_TIME_ZONE, capturedAt: asOf,
          source: 'owner_parent_export', complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
        const selection = selectStreamCandidates({ runs, raceWorkoutIds: new Set(races.flatMap(r => r.actualRunId ? [r.actualRunId] : [])), asOfDate: date });
        const store = new HrStreamEvidenceStore(async (_uid, workoutId, maxChunks) => {
          const chunks = track('hrChunks', await tx.get(owner.collection('healthWorkouts').doc(workoutId).collection('hrStream')
            .orderBy('chunkIndex').limit(maxChunks)), maxChunks);
          const samples: { ms: number; bpm: number }[] = [];
          for (const d of chunks) {
            const raw = d.data().samples;
            if (Array.isArray(raw)) for (const s of raw) {
              const ms = toDate(s.t).getTime();
              if (Number.isFinite(ms) && ms <= Date.parse(asOf) && typeof s.hr === 'number') samples.push({ ms, bpm: s.hr });
            }
          }
          const start = samples.length ? Math.min(...samples.map(s => s.ms)) : 0;
          return { chunks: chunks.length, samples: samples.map(s => ({ t: (s.ms - start) / 1000, bpm: s.bpm })) };
        }, () => Date.parse(asOf));
        const report = await store.hydrate(uid, 1, () => true, selection.candidates);
        input.options.streamSummaries = report?.summaries;
        input.options.streamLoad = report?.state ?? 'failed';
        if (report?.failed || report?.skippedBudget || Object.values(report?.summaries ?? {}).some(s => s.flags.includes('stream_truncated_by_read_bound')))
          limitations.push('hr_stream_evidence_incomplete');
      }
      return { input, usage: { documents, queryMinimumReads, firestoreWrites: 0 }, limitations,
        evidenceDigest: digest(revisions), discovered: races.flatMap(r => { const meta = scheduledRace(r as unknown as Record<string, unknown>); return meta ? [meta] : []; }) };
    }, { readOnly: true });
    } catch (cause) {
      const error = new Error(cause instanceof Error && cause.message.startsWith('Evidence overflow:') ? cause.message : 'Validation evidence read failed');
      Object.assign(error, { usage: { documents, queryMinimumReads, firestoreWrites: 0 }, accountingComplete: false });
      // Only aggregate completed-query counts travel outward; exception text and data never do.
      void cause; throw error;
    }
  };
}
