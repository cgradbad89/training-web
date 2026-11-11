// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createValidationEvidenceReader, createValidationMetadataReader, validationWorkout } from './prediction-source';
import { calculateValidation } from './prediction-models';
import { athleteV11 } from '@/utils/__tests__/fixtures/hybridV11Fixture';
import { computeCurrentFitness } from '@/utils/performance/hybridCurrentFitness';
import { parseStoredBestEfforts } from '@/utils/bestEfforts';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp as AdminTimestamp } from 'firebase-admin/firestore';
import { Timestamp as BrowserTimestamp } from 'firebase/firestore';
import { docToHealthWorkout } from '@/services/healthWorkouts';
import { confirmedRaceFixture } from '@/utils/__tests__/fixtures/raceConfirmationFixture';
import { evaluateRacePerformance } from '@/utils/racePerformance';
const AT = '2026-11-15T14:00:00.000Z';
/** Minimal query/transaction simulator, including field masks, bounds and a single server read time. No credentials or writes. */
function fixtureDb(data: Record<string, Record<string, unknown>[]>) {
  const calls: { path: string; fields: string[]; filters: unknown[][]; bound: number }[] = [];
  const stamp = (at: string) => ({ seconds: Date.parse(at) / 1000, nanoseconds: 0, toDate: () => new Date(at), toMillis: () => Date.parse(at), isEqual: (s: { seconds: number }) => s.seconds === Date.parse(at) / 1000 });
  class Query {
    fields: string[] = []; filters: unknown[][] = []; bound = Infinity;
    constructor(public path: string) {}
    collection(name: string) { return new Query(`${this.path}/${name}`); }
    doc(id: string) { return new Query(`${this.path}/${id}`); }
    where(...filter: unknown[]) { this.filters.push(filter); return this; }
    orderBy() { return this; }
    select(...fields: string[]) { this.fields = fields; return this; }
    limit(n: number) { this.bound = n; return this; }
    async get() {
      calls.push({ path: this.path, fields: this.fields, filters: this.filters, bound: this.bound });
      const rows = (data[this.path] ?? []).filter(row => this.filters.every(([f, op, val]) => op === '==' ? row[String(f)] === val
        : (row[String(f)] as number) >= (val as number))).slice(0, this.bound);
      return { size: rows.length, readTime: stamp(AT), docs: rows.map((row, i) => ({ id: String(row.id ?? `row-${i}`), updateTime: stamp('2026-11-15T13:59:59Z'),
        data: () => this.fields.length ? Object.fromEntries(this.fields.filter(f => f in row).map(f => [f, row[f]])) : row })) };
    }
  }
  const db = { projectId: 'fixture', collection: (name: string) => new Query(name),
    runTransaction: async (fn: (tx: { get(q: Query): ReturnType<Query['get']> }) => unknown, options: object) => {
      expect(options).toEqual({ readOnly: true }); return fn({ get: q => q.get() });
    } } as unknown as Firestore;
  return { db, calls };
}
const root = 'users/owner';
describe('single shared consistent hydration', () => {
  it.each([0, 499_999, 500_000, 511_549_000, 916_793_000, 999_999_999])('matches real browser timestamp conversion at %i nanoseconds', nanos => {
    const seconds = 1_789_910_818;
    const admin = new AdminTimestamp(seconds, nanos);
    const browser = new BrowserTimestamp(seconds, nanos);
    for (const entrySource of [undefined, 'manual']) {
      const raw = { startDate: admin, endDate: admin, syncedAt: admin, updatedAt: admin, entrySource };
      const client = { startDate: browser, endDate: browser, syncedAt: browser, updatedAt: browser, entrySource };
      const actual = validationWorkout('synthetic', raw), expected = docToHealthWorkout('synthetic', client);
      expect([actual.startDate, actual.endDate, actual.syncedAt, actual.updatedAt]).toEqual([expected.startDate, expected.endDate, expected.syncedAt, expected.updatedAt]);
    }
  });
  it.each(['endDate', 'syncedAt'] as const)('preserves confirmation integrity for browser-normalized %s while rejecting material changes', field => {
    const f = confirmedRaceFixture();
    const date = f.workout[field];
    const timestamp = new AdminTimestamp(date.getTime() / 1000, 700_000);
    const row = validationWorkout(f.workout.workoutId, { ...f.workout, [field]: timestamp });
    const evaluate = (workout: typeof row) => evaluateRacePerformance({ races: [f.race], workouts: [workout],
      asOf: '2026-10-25T16:00:00.000Z', timeZone: 'America/New_York' }).evidence[0];
    expect(evaluate(row)).toMatchObject({ status: 'verified', finishSeconds: 7871 });
    expect(evaluate({ ...row, durationSeconds: row.durationSeconds + 10 }).reasons).toContain('confirmation_observations_changed');
    expect(evaluate({ ...row, endDate: new Date(row.endDate.getTime() + 1000) }).reasons).toContain('confirmation_observations_changed');
    expect(evaluate({ ...row, syncedAt: new Date(row.syncedAt.getTime() + 1000) }).reasons).toContain('confirmation_observations_changed');
    expect(f.revision.details.conditions).toBe('Flat, mild, no limitations');
  });
  it('reads each parent collection once and reuses best-effort and weather inputs for all models', async () => {
    const a = athleteV11();
    const raw = a.workouts.map(w => ({ ...w, id: w.workoutId, bestEfforts: w.bestEfforts ? { ...w.bestEfforts, computedFromPointCount: 1000 } : undefined }));
    const world = fixtureDb({ [`${root}/healthWorkouts`]: raw, [`${root}/halfMarathonRaces`]: a.races.map(r => ({ ...r })),
      [`${root}/healthMetrics`]: [{ id: 'vo2', date: '2026-11-10', vo2_max: 40 }] });
    const result = await createValidationEvidenceReader(world.db, 'owner', 'fixture')(AT, true);
    for (const collection of ['healthWorkouts', 'halfMarathonRaces', 'workoutOverrides', 'plans', 'healthMetrics'])
      expect(world.calls.filter(c => c.path === `${root}/${collection}`)).toHaveLength(1);
    const predictions = calculateValidation(result.input, []);
    expect(world.calls).toHaveLength(5); // all fixtures lack streams: no child queries, including GPS
    const identical = computeCurrentFitness({ ...result.input, timeZone: 'America/New_York' }, result.input.options);
    expect(predictions.currentFitness.map(p => p.seconds)).toEqual(identical.rows.map(r => r.estimate.seconds));
    expect(world.calls.find(c => c.path.endsWith('/healthWorkouts'))!.fields).toContain('bestEfforts');
    expect(world.calls.every(c => !c.fields.includes('notes') && !c.path.includes('/route'))).toBe(true);
    expect(result.input.workouts[0].bestEfforts).toEqual(parseStoredBestEfforts(raw[0].bestEfforts));
  });
  it('queries only minimal active race metadata during daily discovery', async () => {
    const w = fixtureDb({ [`${root}/halfMarathonRaces`]: [{ id: 'one', raceDate: '2027-03-20', raceDistance: 'halfMarathon', isActive: true, name: 'PRIVATE NAME' },
      { id: 'other', raceDate: '2027-03-22', raceDistance: 'halfMarathon', isActive: false }] });
    const result = await createValidationMetadataReader(w.db, 'owner', 'fixture')();
    expect(result.races).toHaveLength(1); expect(w.calls).toHaveLength(1); expect(w.calls[0].fields).not.toContain('name');
    expect(w.calls[0].filters).toContainEqual(['isActive', '==', true]); expect(JSON.stringify(result)).not.toContain('PRIVATE NAME');
  });
  it('fails on overflow instead of emitting a truncated successful estimate', async () => {
    const w = fixtureDb({ [`${root}/halfMarathonRaces`]: Array.from({ length: 101 }, (_, i) => ({ id: `r${i}` })) });
    await expect(createValidationEvidenceReader(w.db, 'owner', 'fixture')(AT, false)).rejects.toThrow('overflow');
    expect(w.calls[0].bound).toBe(1001); expect(w.calls[1].bound).toBe(101);
  });
  it('refuses wrong project or owner path before data access', () => {
    const w = fixtureDb({}); expect(() => createValidationEvidenceReader(w.db, 'owner', 'other')).toThrow();
    expect(() => createValidationMetadataReader(w.db, 'bad/path', 'fixture')).toThrow(); expect(w.calls).toHaveLength(0);
  });
  it('normalizes manual availability and preserves route/best-effort evidence', () => {
    const row = validationWorkout('manual', { entrySource: 'manual', updatedAt: new Date(AT), routeComplete: false, bestEfforts: { '5k': 1800 }, notes: 'PRIVATE' });
    expect(row.syncedAt.toISOString()).toBe(AT); expect(row.updatedAt?.toISOString()).toBe(AT); expect(row.routeComplete).toBe(false); expect(row).not.toHaveProperty('notes');
  });
});
