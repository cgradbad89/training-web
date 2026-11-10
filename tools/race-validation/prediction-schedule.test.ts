// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { easternHour, intendedAt, inCaptureWindow, reportingDate, scheduledRace, validationObject, validationSlots } from './prediction-schedule';
const race = (extra = {}) => scheduledRace({ id: 'saved', isActive: true, raceDate: '2027-03-20', raceDistance: 'halfMarathon', ...extra });
describe('Eastern weekly and pre-race schedule', () => {
  it.each([
    ['2026-11-15', '2026-11-15T14:00:00.000Z'], ['2026-07-12', '2026-07-12T13:00:00.000Z'],
    ['2027-03-14', '2027-03-14T13:00:00.000Z'], ['2026-11-01', '2026-11-01T14:00:00.000Z'],
  ])('targets Sunday %s at 09 Eastern across both DST changes', (date, at) => {
    expect(intendedAt(date)).toBe(at); expect(easternHour(at)).toBe(9);
    expect(validationSlots(date, [], 'v1')).toHaveLength(1);
    expect(validationSlots(date, [], 'v1')[0]).toMatchObject({ type: 'weekly', intendedAt: at });
    expect(inCaptureWindow(new Date(Date.parse(at) - 1).toISOString())).toBe(false);
    expect(inCaptureWindow(new Date(Date.parse(at) + 3599999).toISOString())).toBe(true);
    expect(inCaptureWindow(new Date(Date.parse(at) + 3600000).toISOString())).toBe(false);
  });
  it('discovers the day before a saved race without hard-coded race enrollment', () => {
    expect(validationSlots('2027-03-19', [race()!], 'v1')[0]).toMatchObject({ type: 'pre_race', intendedAt: '2027-03-19T13:00:00.000Z' });
    expect(validationSlots('2027-03-18', [race()!], 'v1')).toEqual([]);
  });
  it.each([{ isActive: false }, { canceled: true }, { cancelled: true }, { status: 'cancelled' }, { raceDate: null },
    { raceDate: '03/20/2027' }, { raceDate: '2027-02-30' }, { raceDate: '2027-03-20T09:00:00' }, { raceDistance: 'unknown' }])('rejects canceled/inactive/malformed metadata %j', extra => {
    expect(race(extra)).toBeNull();
  });
  it('reschedules by a new occurrence key and never rewrites the old key', () => {
    const old = validationSlots('2027-03-19', [race()!], 'v1')[0];
    expect(validationSlots('2027-03-19', [race({ raceDate: '2027-03-27' })!], 'v1')).toEqual([]);
    expect(validationSlots('2027-03-26', [race({ raceDate: '2027-03-27' })!], 'v1')[0].id).not.toBe(old.id);
  });
  it('deduplicates multiple races and shares a weekly/pre-race date', () => {
    const one = race({ raceDate: '2026-11-16' })!, two = race({ id: 'second', raceDate: '2026-11-16' })!;
    const slots = validationSlots('2026-11-15', [one, two, one], 'v1');
    expect(slots.map(s => s.type)).toEqual(['weekly', 'pre_race', 'pre_race']);
    expect(new Set(slots.map(s => s.id)).size).toBe(3);
  });
  it('separates evaluation versions and preserves Eastern date near midnight', () => {
    expect(validationObject('2026-11-15', 'v1')).not.toBe(validationObject('2026-11-15', 'v2'));
    expect(reportingDate('2026-11-16T03:00:00Z')).toBe('2026-11-15');
  });
});
