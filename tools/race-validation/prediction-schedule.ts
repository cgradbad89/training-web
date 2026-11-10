import { isPerformanceDate, performanceLocalDate, shiftPerformanceDate } from '@/utils/performanceEvidence';
import { nominalRaceDistanceMeters } from '@/utils/racePerformance';
import type { Race } from '@/types/race';
import { digest } from './evidence';

export const VALIDATION_PROTOCOL = 'prospective-prediction-validation-v1';
export const VALIDATION_TIME_ZONE = 'America/New_York';
export const VALIDATION_POLICY = 'weekly-prerace-v1';
export interface ScheduledRace {
  id: string; raceDate: string; distanceMeters: number; linkedPlanId: string | null;
}
export interface ValidationSlot {
  id: string; type: 'weekly' | 'pre_race'; reportingDate: string; intendedAt: string;
  race: ScheduledRace | null;
}

/** Calendar-only race dates; never parse a title, notes, result, or an ambiguous datetime. */
export function scheduledRace(raw: Record<string, unknown>): ScheduledRace | null {
  if (typeof raw.id !== 'string' || !raw.id || raw.id.includes('/') || typeof raw.raceDate !== 'string' || !isPerformanceDate(raw.raceDate)) return null;
  if (raw.isActive !== true || raw.canceled === true || raw.cancelled === true || ['canceled', 'cancelled'].includes(String(raw.status))) return null;
  const meters = nominalRaceDistanceMeters(raw as unknown as Race);
  if (!meters || !Number.isFinite(meters) || meters <= 0) return null;
  return { id: raw.id, raceDate: raw.raceDate, distanceMeters: meters,
    linkedPlanId: typeof raw.linkedPlanId === 'string' && !raw.linkedPlanId.includes('/') ? raw.linkedPlanId : null };
}

/** 09:00 exists exactly once on every Eastern day, including both DST transitions. */
export function intendedAt(date: string): string {
  if (!isPerformanceDate(date)) throw new TypeError('Invalid reporting date');
  const at13 = `${date}T13:00:00.000Z`;
  return easternHour(at13) === 9 ? at13 : `${date}T14:00:00.000Z`;
}
export function easternHour(now: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: VALIDATION_TIME_ZONE, hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(now)));
}
export function reportingDate(now: string) { return performanceLocalDate(now, VALIDATION_TIME_ZONE); }
export function inCaptureWindow(now: string) { return easternHour(now) === 9; }
export function weeklyDate(date: string) { return new Date(`${date}T12:00:00Z`).getUTCDay() === 0; }
export function validationSlots(date: string, races: readonly ScheduledRace[], evaluationVersion: string): ValidationSlot[] {
  const make = (type: ValidationSlot['type'], race: ScheduledRace | null): ValidationSlot => ({
    id: digest([VALIDATION_PROTOCOL, evaluationVersion, type, date, race?.id ?? null, race?.raceDate ?? null]),
    type, reportingDate: date, intendedAt: intendedAt(date), race,
  });
  const unique = new Map(races.map(r => [r.id, r]));
  return [...(weeklyDate(date) ? [make('weekly', null)] : []), ...[...unique.values()]
    .filter(r => shiftPerformanceDate(r.raceDate, -1) === date).sort((a, b) => a.id.localeCompare(b.id)).map(r => make('pre_race', r))];
}
export function validationObject(date: string, evaluationVersion: string, kind = 'capture'): string {
  if (!isPerformanceDate(date) || !/^(capture|claim-[12]|failure-[12])$/.test(kind)) throw new TypeError('Invalid validation key');
  return `prediction-validation/v1/${digest([VALIDATION_PROTOCOL, evaluationVersion, date, kind])}.json`;
}
