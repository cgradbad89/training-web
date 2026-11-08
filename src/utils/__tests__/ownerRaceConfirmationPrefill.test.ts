import { describe, expect, it } from "vitest";
import type { Race } from "@/types/race";
import { buildRaceConfirmationInput } from "@/utils/raceConfirmation";
import { parseRaceResultSeconds } from "@/utils/racePerformance";
import { confirmedRaceFixture } from "@/utils/__tests__/fixtures/raceConfirmationFixture";
import { ownerRaceConfirmationPrefill } from "../ownerRaceConfirmationPrefill";

const race = (date: string, extra: Partial<Race> = {}): Race => ({ id: "r", name: "Synthetic", raceDate: date, raceDistance: "halfMarathon", isActive: false, createdAt: "2026-01-01T00:00:00.000Z", ...extra });

describe("owner confirmation prefill", () => {
  it("applies only to the two half marathons and only before a confirmation exists", () => {
    expect(ownerRaceConfirmationPrefill(race("2026-04-26"))?.effort).toBe("nonmaximal");
    expect(ownerRaceConfirmationPrefill(race("2026-09-20"))?.effort).toBe("hard");
    expect(ownerRaceConfirmationPrefill(race("2026-09-21"))).toBeNull();
    expect(ownerRaceConfirmationPrefill(race("2026-09-20", { raceDistance: "10K" }))).toBeNull();
    expect(ownerRaceConfirmationPrefill(confirmedRaceFixture({ date: "2026-09-20" }).race)).toBeNull();
  });
  it("invents no weather, course, URL or timing basis; the effort percentage lives only in the note", () => {
    for (const date of ["2026-04-26", "2026-09-20"]) {
      const p = ownerRaceConfirmationPrefill(race(date))!;
      expect(p.source).not.toMatch(/https?:\/\//);
      expect(p.conditions).not.toMatch(/weather|flat|hilly|temperature|humid|course/i);
      expect(p.conditions).toMatch(/\(subjective, not a physiological measurement\)/);
      expect([p.finish, p.timeBasis, p.status, p.effort, p.source, p.timingReconciliation].join(" ")).not.toMatch(/80|90|%/);
    }
    expect(ownerRaceConfirmationPrefill(race("2026-04-26"))!.timeBasis).toBe("other");
  });
  it("each prefilled draft passes the app's own validation against a synthetic workout shaped like the race (April needs, and has, its timing explanation)", () => {
    for (const [date, seconds, elapsed] of [["2026-09-20", 7871, undefined], ["2026-04-26", 8130, 8759]] as const) {
      const f = confirmedRaceFixture({ id: `r-${date}`, date, seconds, elapsed }); delete f.race.confirmationHistory;
      const p = ownerRaceConfirmationPrefill({ ...f.race, raceDate: date })!;
      const draft = { officialEventName: f.race.name, raceDate: date, distanceMeters: 21097.5, finishSeconds: parseRaceResultSeconds(p.finish)!, timeBasis: p.timeBasis, status: p.status,
        effort: p.effort, conditions: p.conditions, source: p.source, timingReconciliation: p.timingReconciliation || null };
      expect(draft.finishSeconds).toBe(seconds);
      expect(() => buildRaceConfirmationInput({ race: f.race, workout: f.workout, override: null, timeZone: "America/New_York", draft, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).not.toThrow();
      if (elapsed) expect(() => buildRaceConfirmationInput({ race: f.race, workout: f.workout, override: null, timeZone: "America/New_York", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        draft: { ...draft, timingReconciliation: null } })).toThrow(/timing explanation/i);
    }
  });
});
