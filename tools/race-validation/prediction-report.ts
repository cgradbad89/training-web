import { isPerformanceDate, shiftPerformanceDate } from '@/utils/performanceEvidence';
import type { ValidationCapture, ValidationStore } from './prediction-capture';
import { verifyValidation } from './prediction-capture';
import { reportingDate, validationObject, weeklyDate, intendedAt } from './prediction-schedule';

/** Stored prospective outputs only: never re-run a model to fill a gap in the history. */
export function comparePredictionOutcomes(records: readonly ValidationCapture[]) {
  const outcomes = [...new Map(records.flatMap(r => r.predictions.outcomes).map(o => [`${o.raceId}:${o.raceDate}`, o])).values()];
  const comparisons = records.flatMap(record => outcomes.flatMap(outcome => {
    const leadDays = (Date.parse(`${outcome.raceDate}T00:00:00Z`) - Date.parse(`${record.reportingDate}T00:00:00Z`)) / 86_400_000;
    if (leadDays <= 0 || record.status !== 'complete') return [];
    const error = (seconds: number, kind: string, model: string, quality: string | null) => ({
      kind, raceId: outcome.raceId, raceDate: outcome.raceDate, snapshotDate: record.reportingDate,
      snapshotIds: record.snapshots.map(s => s.id), evaluatedAt: record.evaluatedAt, daysBeforeRace: leadDays,
      predictedSeconds: seconds, actualSeconds: outcome.actualSeconds, errorSeconds: seconds - outcome.actualSeconds,
      absolutePercentageError: Math.abs(seconds - outcome.actualSeconds) / outcome.actualSeconds * 100,
      direction: seconds < outcome.actualSeconds ? 'optimistic' : seconds > outcome.actualSeconds ? 'pessimistic' : 'exact',
      model, evidenceQuality: quality,
    });
    // Conservative current-capability comparison: same distance, maximal confirmed outcome, <= 7 calendar days away.
    const current = leadDays <= 7 ? record.predictions.currentFitness.flatMap(p => p.seconds !== null
      && Math.abs(p.distanceMeters - outcome.distanceMeters) <= 25 ? [error(p.seconds, 'current_fitness', p.model, p.evidenceQuality)] : []) : [];
    const forecast = record.predictions.planInsights.forecasts.flatMap(f => f.raceId === outcome.raceId && f.raceDate === outcome.raceDate
      && Math.abs(f.distanceMeters - outcome.distanceMeters) <= 25 && f.seconds !== null
      ? [error(f.seconds, 'race_day_forecast', f.model, record.predictions.planInsights.currentHybrid.evidenceQuality)] : []);
    return [...current, ...forecast];
  }));
  const distinct = new Set(comparisons.map(c => `${c.raceId}:${c.raceDate}`)).size;
  return { status: distinct >= 3 ? 'comparisons_available' : 'insufficient_qualifying_outcomes', qualifiedRaces: distinct,
    accuracyStatistics: null, comparisons,
    limitations: ['Current fitness requires a comparable maximal performance within 7 calendar days; fitness and conditions can still change.',
      'No calibrated accuracy statistics, causal conclusions, or automatic coefficient updates.'] };
}

export function summarizePredictionHistory(records: readonly ValidationCapture[]) {
  const sorted = [...records].sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
  const changes = sorted.slice(1).map((current, i) => {
    const prior = sorted[i];
    return { from: prior.reportingDate, to: current.reportingDate,
      applicationVersionChanged: prior.applicationRevision !== current.applicationRevision,
      evaluationVersionChanged: prior.evaluationVersion !== current.evaluationVersion,
      evidenceChanged: prior.evidenceDigest !== current.evidenceDigest,
      distances: current.predictions.currentFitness.map(p => {
        const before = prior.predictions.currentFitness.find(row => row.id === p.id);
        const delta = before?.seconds != null && p.seconds !== null ? p.seconds - before.seconds : null;
        return { id: p.id, changeSeconds: delta, largeShift: delta !== null && Math.abs(delta) >= Math.max(120, before!.seconds! * 0.03),
          observations: { before: before?.diagnostics ?? null, after: p.diagnostics },
          attribution: 'Diagnostic changes are observations; they do not establish causation.' };
      }) };
  });
  return { latestSuccessful: sorted.findLast(r => r.status === 'complete') ?? null, captures: sorted, changes,
    validation: comparePredictionOutcomes(sorted) };
}

/** Authenticated caller only; bounded to 90 dates and this evaluation version. GCS verifier needs no list permission. */
export async function readPredictionReport(store: ValidationStore, version: string, from: string, to: string, now: string) {
  if (!isPerformanceDate(from) || !isPerformanceDate(to) || from > to || to > reportingDate(now)
    || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 89) throw new Error('Report requires 1–90 calendar days');
  await store.verifyPolicy();
  const records: ValidationCapture[] = [], history: object[] = [];
  for (let day = from; day <= to; day = shiftPerformanceDate(day, 1)) {
    const capture = await store.read(validationObject(day, version));
    if (capture) {
      const record = verifyValidation(capture.artifact);
      if (record.reportingDate !== day || record.evaluationVersion !== version) throw new Error('Report generation mismatch');
      records.push(record); history.push({ date: day, status: record.status, generation: capture.generation }); continue;
    }
    const attempts = [];
    for (const n of [1, 2]) {
      const claim = await store.read(validationObject(day, version, `claim-${n}`));
      if (claim) {
        const failed = await store.read(validationObject(day, version, `failure-${n}`));
        attempts.push({ attempt: n, status: failed ? 'failed' : Date.parse(now) - Date.parse(claim.createdAt) < 330_000 ? 'in_progress' : 'interrupted',
          claim: claim.artifact, failure: failed?.artifact ?? null });
      }
    }
    const closed = Date.parse(now) >= Date.parse(intendedAt(day)) + 3_600_000;
    history.push({ date: day, status: attempts.length ? 'failed' : weeklyDate(day) ? closed ? 'missed' : 'pending' : 'no_capture_record', attempts });
  }
  return { ...summarizePredictionHistory(records), history,
    reportingVersion: version, reportingRange: { from, to },
    limitations: ['Missing weekly records are reported only within the configured activation range.',
      'Absent pre-race claims cannot establish a historical enrollment after race deletion/rescheduling. No historical date is inferred.',
      'Query another recorded evaluationVersion explicitly to inspect older model/flag versions.'] };
}
