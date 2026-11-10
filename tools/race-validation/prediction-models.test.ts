// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { APRIL_RACE, SEPTEMBER_RACE, fitnessWorld, strongEffortWorld } from '@/utils/__tests__/fixtures/currentFitnessFixture';
import { athleteV11, makeRun } from '@/utils/__tests__/fixtures/hybridV11Fixture';
import { computeCurrentFitness } from '@/utils/performance/hybridCurrentFitness';
import { estimateCurrentHalfMarathon } from '@/utils/experimentalCurrentPerformance';
import { estimateHrEnhancedHalfMarathon } from '@/utils/hrEnhancedPerformance';
import { estimateHybridHalfMarathonV11 } from '@/utils/performance/hybridPerformanceV11';
import { estimateRaceDayForecast } from '@/utils/performance/raceDayForecast';
import { treatConfirmedRacesAsMaximal } from '@/utils/performance/confirmedRaceAssumption';
import { calculateValidation, DEFAULT_VALIDATION_FLAGS, evaluationVersion, type PredictionInput } from './prediction-models';
import { VALIDATION_TIME_ZONE } from './prediction-schedule';
import type { RunningPlan } from '@/types/plan';
export const syntheticPlan: RunningPlan = { id: 'synthetic-plan', name: 'Fixture', startDate: '2026-11-09', status: 'active', isActive: true,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [
    { id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 },
    { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: Math.min(12, 8 + w * 0.3) },
  ] })) };
const target = { id: 'future', raceDate: '2027-03-20', distanceMeters: 21097.5, linkedPlanId: syntheticPlan.id };
const cases = {
  ordinary: () => fitnessWorld({ asOfDate: '2026-11-10', races: [APRIL_RACE(), SEPTEMBER_RACE()], adapted: false }),
  prepared: () => fitnessWorld({ asOfDate: '2026-10-30', races: [SEPTEMBER_RACE()], adapted: false, gaps: [1, 2, 2, 2], miles: [8, 8, 10, 20, 7, 8] }),
  recentEfforts: () => strongEffortWorld(),
  noRace: () => fitnessWorld({ asOfDate: '2026-11-10' }),
  expired: () => fitnessWorld({ asOfDate: '2027-03-20', races: [SEPTEMBER_RACE()] }),
  sustainedSegments: () => athleteV11({ segments: [{ date: '2026-10-25', hostMiles: 8, hostPace: 600, hr: 172, key: '5k', segPace: 520 }] }),
};
describe('snapshot parity with app calculations', () => {
  for (const [name, make] of Object.entries(cases)) it(`${name}: all distances and Plan Insights match identical inputs`, () => {
    const input: PredictionInput = { ...make(), plans: [syntheticPlan], options: { vo2Load: 'loaded', streamLoad: 'loaded', vo2Entries: [], streamSummaries: {} } };
    const before = structuredClone(input), result = calculateValidation(input, [target]);
    const races = treatConfirmedRacesAsMaximal(input.races);
    const base = { ...input, races, timeZone: VALIDATION_TIME_ZONE };
    const official = estimateCurrentHalfMarathon(base);
    const hr = official.finishMinutes === null ? null : estimateHrEnhancedHalfMarathon(base, { official });
    const options = { ...input.options, official, hrEnhanced: hr };
    const planHybrid = estimateHybridHalfMarathonV11(base, options);
    const personal = computeCurrentFitness({ ...base, assumeConfirmedRacesMaximal: false }, { ...input.options, official });
    expect(result.currentFitness.map(r => [r.seconds, r.displayedSeconds, r.paceSecondsPerMile, r.status, r.confidence, r.evidenceQuality]))
      .toEqual(personal.rows.map(r => [r.estimate.seconds, r.finishSeconds, r.paceSecondsPerMile, r.status, r.confidence, r.evidenceQuality]));
    expect(result.planInsights.currentHybrid.seconds).toBe(planHybrid.seconds);
    const f = estimateRaceDayForecast(base, { ...options, raceDate: target.raceDate, plan: syntheticPlan, hybrid: planHybrid });
    expect(result.planInsights.forecasts[0]).toMatchObject({ seconds: f.seconds, displayedSeconds: f.minutes === null ? null : f.minutes * 60, status: f.status });
    expect(result.planInsights.official.displayedSeconds).toBe(official.finishMinutes === null ? null : official.finishMinutes * 60);
    expect(result.planInsights.hrEnhanced.seconds).toBe(hr?.candidateSeconds ?? null);
    expect(result.models).toMatchObject({ hybrid: 'experimental-hybrid-hm-v1.1', official: 'experimental-current-hm-v2', forecast: 'experimental-raceday-forecast-v2' });
    expect(input).toEqual(before);
  });
  it('reports unavailable forecasts without inventing a plan or target date', () => {
    const input = { ...cases.ordinary(), plans: [], options: {} };
    expect(calculateValidation(input, []).planInsights.forecasts).toEqual([]);
    expect(calculateValidation(input, [target]).planInsights.forecasts[0]).toMatchObject({ seconds: null, reason: 'linked_running_plan_unavailable' });
    expect(calculateValidation(input, [{ ...target, distanceMeters: 5000 }]).planInsights.forecasts[0].reason).toBe('forecast_half_marathon_only');
  });
  it('does not introduce planned training gains into current fitness', () => {
    const input = { ...cases.ordinary(), plans: [], options: {} };
    expect(calculateValidation({ ...input, plans: [syntheticPlan] }, [target]).currentFitness).toEqual(calculateValidation(input, []).currentFitness);
  });
  it('excludes future workouts, later ingestion and later confirmation from the model', () => {
    const input = { ...cases.ordinary(), plans: [], options: {} };
    const future = makeRun({ id: 'future-private', date: '2027-03-20', pace: 480, hr: 180, minutes: 50 });
    const late = { ...input.workouts[0], workoutId: 'late-private', syncedAt: new Date('2027-03-21T00:00:00Z') };
    const old = calculateValidation(input, []);
    const later = calculateValidation({ ...input, workouts: [...input.workouts, future, late] }, []);
    expect(later.currentFitness.map(r => r.seconds)).toEqual(old.currentFitness.map(r => r.seconds));
  });
  it('stores no raw workouts, stream samples, routes or names', () => {
    const result = calculateValidation({ ...cases.ordinary(), plans: [], options: {} }, []);
    expect(result).not.toHaveProperty('workouts'); expect(result).not.toHaveProperty('races');
    for (const row of result.currentFitness) { expect(row.diagnostics).not.toHaveProperty('qualification'); expect(row.diagnostics).not.toHaveProperty('items'); }
  });
  it('never promotes training or assumed-maximal predictions into validation outcomes', () => {
    expect(calculateValidation({ ...cases.ordinary(), plans: [], options: {} }, []).outcomes).toEqual([]);
    expect(calculateValidation({ ...cases.recentEfforts(), races: [], plans: [], options: {} }, []).outcomes).toEqual([]);
  });
  it('changes the evaluation key on a policy/feature-flag change', () => {
    expect(evaluationVersion(DEFAULT_VALIDATION_FLAGS)).not.toBe(evaluationVersion({ ...DEFAULT_VALIDATION_FLAGS, physiology: false }));
  });
});
