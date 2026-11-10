// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPrivateCaptureStore } from './capture-storage';
import { createFakeGcs } from './fake-gcs';
import { runPredictionCapture, sealValidation, verifyValidation, type ValidationCapture } from './prediction-capture';
import { DEFAULT_VALIDATION_FLAGS, evaluationVersion } from './prediction-models';
import { validationObject } from './prediction-schedule';
import { readPredictionReport, comparePredictionOutcomes, summarizePredictionHistory } from './prediction-report';
import type { ValidationSource } from './prediction-source';
const flags = DEFAULT_VALIDATION_FLAGS, version = evaluationVersion(flags);
function world(date = '2026-11-15T14:00:00.000Z') {
  let at = date;
  const now = () => at;
  const gcs = createFakeGcs({ bucket: 'validation-private', clock: now, retentionSeconds: 365 * 86400, locked: true });
  const store = createPrivateCaptureStore<unknown>({ namespace: 'prediction-validation', bucket: 'validation-private', minimumRetentionSeconds: 365 * 86400,
    request: gcs.fetch, writer: { principal: 'writer', accessToken: async () => 'writer' }, verifier: { principal: 'verifier', accessToken: async () => 'verifier' } });
  const source = (): ValidationSource => ({ input: { asOf: at, workouts: [], races: [], overrides: {}, plans: [], options: {} },
    usage: { documents: { workouts: 0, races: 0, overrides: 0, plans: 0 }, queryMinimumReads: 4, firestoreWrites: 0 },
    limitations: [], evidenceDigest: 'synthetic', discovered: [] });
  const evidence = vi.fn(async () => source());
  const metadata = vi.fn(async () => ({ races: source().discovered, documentsRead: 0, minimumReads: 1 }));
  const config = { codeRevision: 'fixture-sha', flags, startDate: '2026-11-10' };
  const ports = { now, store, metadata, evidence };
  return { now, set: (s: string) => { at = s; }, gcs, store, evidence, metadata, config, ports, source,
    run: (dryRun = false) => runPredictionCapture(config, ports, dryRun) };
}
function amended(record: ValidationCapture, extra: Partial<ValidationCapture>): ValidationCapture {
  const payload = { ...record, ...extra }; delete (payload as Partial<typeof payload>).integrityDigest; return sealValidation(payload);
}
describe('immutable bounded capture', () => {
  it('writes one capture plus one claim and retries are read-only duplicates', async () => {
    const w = world(), first = await w.run();
    expect(first.status).toBe('complete'); expect(w.evidence).toHaveBeenCalledTimes(1); expect(w.gcs.objects.size).toBe(2);
    const original = (await w.store.read(validationObject('2026-11-15', version)))!;
    const record = verifyValidation(original.artifact);
    expect(record.usage.snapshotBytes).toBe(Buffer.byteLength(JSON.stringify(record)));
    expect(record.predictions.currentFitness.every(r => r.seconds === null && r.reason)).toBe(true);
    expect(record.snapshots[0]).toMatchObject({ type: 'weekly', intendedAt: '2026-11-15T14:00:00.000Z' });
    expect(await w.run()).toMatchObject({ status: 'duplicate', generation: first.generation });
    expect(w.evidence).toHaveBeenCalledTimes(1);
    expect((await w.store.read(validationObject('2026-11-15', version)))!.artifact).toEqual(original.artifact);
  });
  it('allows exactly one concurrent hydration and one capture generation', async () => {
    const w = world(); const results = await Promise.all([w.run(), w.run(), w.run()]);
    expect(w.evidence).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.status === 'complete')).toHaveLength(1);
    expect(w.gcs.objects.size).toBe(2);
  });
  it('weekly and multiple pre-race snapshots reuse one evaluation', async () => {
    const w = world();
    const targets = ['one', 'two'].map(id => ({ id, raceDate: '2026-11-16', distanceMeters: 21097.5, linkedPlanId: null }));
    w.metadata.mockResolvedValue({ races: targets, documentsRead: 2, minimumReads: 2 });
    w.evidence.mockImplementation(async () => ({ ...w.source(), discovered: targets }));
    const result = await w.run(); expect(result.status).toBe('complete'); expect(w.evidence).toHaveBeenCalledTimes(1);
    const capture = verifyValidation((await w.store.read(validationObject('2026-11-15', version)))!.artifact);
    expect(capture.snapshots.map(s => s.type)).toEqual(['weekly', 'pre_race', 'pre_race']);
    expect(capture.snapshots.slice(1).every(s => s.takenBeforeRace)).toBe(true);
  });
  it('revalidates rescheduled/canceled races within evidence read', async () => {
    const w = world('2027-03-19T13:00:00.000Z');
    w.metadata.mockResolvedValue({ races: [{ id: 'one', raceDate: '2027-03-20', distanceMeters: 21097.5, linkedPlanId: null }], documentsRead: 1, minimumReads: 1 });
    expect((await w.run()).status).toBe('failed');
    expect(await w.store.read(validationObject('2027-03-19', version))).toBeNull();
  });
  it('recovers once from a transient evidence failure and cannot retry without bounds', async () => {
    const w = world(); w.evidence.mockRejectedValueOnce(new Error('PRIVATE FAILURE TEXT'));
    expect((await w.run()).status).toBe('complete'); expect(w.evidence).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([...w.gcs.objects.values()].map(o => new TextDecoder().decode(o.body)))).not.toContain('PRIVATE FAILURE');
    const bad = world(); bad.evidence.mockRejectedValue(new Error('no access'));
    expect((await bad.run()).status).toBe('failed'); expect((await bad.run()).status).toBe('failed');
    expect(bad.evidence).toHaveBeenCalledTimes(2); expect(bad.gcs.objects.size).toBe(4);
  });
  it('preserves partial read accounting across bounded recovery', async () => {
    const w = world();
    w.evidence.mockRejectedValueOnce(Object.assign(new Error('read interrupted'), { usage: { documents: { workouts: 10 }, queryMinimumReads: 10, firestoreWrites: 0 } }));
    expect((await w.run()).status).toBe('complete');
    const record = verifyValidation((await w.store.read(validationObject('2026-11-15', version)))!.artifact);
    expect(record.usage.documents.workouts).toBe(10); expect(record.usage.queryMinimumReads).toBe(14);
    expect(record.usage.readAccountingComplete).toBe(false);
  });
  it('never retries an in-flight claim or rewrites an older interrupted claim', async () => {
    const w = world(); const name = validationObject('2026-11-15', version, 'claim-1');
    await w.store.create(name, { started: true });
    expect((await w.run()).status).toBe('in_progress'); expect(w.evidence).not.toHaveBeenCalled();
    w.set('2026-11-15T14:06:00.000Z'); expect((await w.run()).status).toBe('complete');
    expect(w.evidence).toHaveBeenCalledTimes(1); expect((await w.store.read(name))!.artifact).toEqual({ started: true });
  });
  it('refuses an evaluation outside its actual schedule window or after the boundary', async () => {
    const w = world('2026-11-15T13:00:00.000Z'); expect((await w.run()).status).toBe('idle'); expect(w.metadata).not.toHaveBeenCalled();
    w.set('2026-11-15T14:59:59.000Z'); w.evidence.mockImplementation(async () => { const src = w.source(); w.set('2026-11-15T15:00:01.000Z'); return src; });
    expect((await w.run()).status).toBe('missed'); expect(await w.store.read(validationObject('2026-11-15', version))).toBeNull();
  });
  it('refuses future evidence timestamps', async () => {
    const w = world(); w.evidence.mockImplementation(async () => { const source = w.source(); source.input.asOf = '2026-11-16T00:00:00Z'; return source; });
    expect((await w.run()).status).toBe('failed'); expect(await w.store.read(validationObject('2026-11-15', version))).toBeNull();
  });
  it('records incomplete physiology as incomplete, never successful', async () => {
    const w = world(); w.evidence.mockImplementation(async () => ({ ...w.source(), limitations: ['hr_stream_evidence_incomplete'] }));
    expect((await w.run()).status).toBe('incomplete');
  });
  it('dry-run produces no storage writes and a failing bucket policy prevents hydration', async () => {
    const w = world(); expect((await w.run(true)).status).toBe('dry_run'); expect(w.gcs.objects.size).toBe(0);
    const bad = world(); bad.gcs.state.publicAccessPrevention = 'inherited';
    await expect(bad.run()).rejects.toThrow(); expect(bad.evidence).not.toHaveBeenCalled();
  });
  it('rejects tampered captures without replaying a newer model', async () => {
    const w = world(); await w.run(); const stored = (await w.store.read(validationObject('2026-11-15', version)))!;
    const record = structuredClone(verifyValidation(stored.artifact)); record.applicationRevision = 'changed';
    expect(() => verifyValidation(record)).toThrow('integrity');
  });
});
describe('developer history and actual-outcome comparisons', () => {
  it('reports missing Sundays and failed pre-race attempts without backfilling predictions', async () => {
    const w = world(); await w.run();
    const report = await readPredictionReport(w.store, version, '2026-11-15', '2026-11-22', '2026-11-22T16:00:00Z');
    expect(report.captures).toHaveLength(1); expect(report.history.at(-1)).toMatchObject({ status: 'missed' });
    expect(report.validation.status).toBe('insufficient_qualifying_outcomes');
  });
  it('scores qualified future outcomes separately from current fitness and refuses same-day/far-away current fitness', async () => {
    const w = world(); await w.run(); const r = verifyValidation((await w.store.read(validationObject('2026-11-15', version)))!.artifact);
    const predict = amended(r, { predictions: { ...r.predictions,
      currentFitness: r.predictions.currentFitness.map(p => ({ ...p, seconds: 8000 })),
      planInsights: { ...r.predictions.planInsights, forecasts: [{ raceId: 'actual', raceDate: '2026-11-20', distanceMeters: 21097.5,
        seconds: 8100, model: 'experimental-raceday-forecast-v2', status: 'provisional' } as never] } } });
    const actual = amended(r, { reportingDate: '2026-11-22', predictions: { ...r.predictions, outcomes: [
      { raceId: 'actual', raceDate: '2026-11-20', distanceMeters: 21097.5, actualSeconds: 8200, knownAt: '2026-11-21T00:00:00Z', status: 'verified', timingBasis: 'chip' },
    ] } });
    const report = comparePredictionOutcomes([predict, actual]);
    expect(report.comparisons.map(c => c.kind)).toEqual(['current_fitness', 'race_day_forecast']);
    expect(report.comparisons[0]).toMatchObject({ errorSeconds: -200, direction: 'optimistic', daysBeforeRace: 5 });
    expect(report.comparisons[0].absolutePercentageError).toBeCloseTo(200 / 8200 * 100);
    expect(comparePredictionOutcomes([amended(predict, { reportingDate: '2026-11-20' }), actual]).comparisons).toEqual([]);
    expect(comparePredictionOutcomes([amended(predict, { reportingDate: '2026-11-01' }), actual]).comparisons.map(c => c.kind)).toEqual(['race_day_forecast']);
    expect(summarizePredictionHistory([predict, actual]).changes[0].distances[0].attribution).toContain('do not establish causation');
  });
  it('bounds reporting range before object reads', async () => {
    const w = world(); await expect(readPredictionReport(w.store, version, '2026-01-01', '2026-11-15', w.now())).rejects.toThrow('1–90');
    expect(w.gcs.calls).toHaveLength(0);
  });
});
