import { describe, it, expect } from "vitest";
import {
  projectShoeReplacement,
  type ShoeRunMiles,
} from "@/utils/shoeProjection";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

/** A run `daysAgo` before NOW with `miles`. */
function run(daysAgo: number, miles: number): ShoeRunMiles {
  return { dateISO: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), miles };
}

describe("projectShoeReplacement", () => {
  it("returns null when no usable limit is set", () => {
    expect(
      projectShoeReplacement({ currentMiles: 100, limit: undefined }, [], NOW),
    ).toBeNull();
    expect(
      projectShoeReplacement({ currentMiles: 100, limit: 0 }, [], NOW),
    ).toBeNull();
  });

  it("'ok' case: computes recent rate and a correct projected date", () => {
    // 20 mi/week over the last 4 weeks (80 mi in 28d). 100 mi left → 5 weeks.
    const runs = [run(1, 20), run(8, 20), run(15, 20), run(22, 20)];
    const p = projectShoeReplacement(
      { currentMiles: 200, limit: 300 },
      runs,
      NOW,
    )!;
    expect(p.state).toBe("ok");
    expect(p.recentMilesPerWeek).toBe(20); // 80 / 4
    expect(p.milesRemaining).toBe(100);
    // 100 / 20 = 5 weeks = 35 days from NOW.
    const expected = new Date(NOW.getTime() + 35 * DAY);
    expect(p.projectedDate!.getTime()).toBe(expected.getTime());
  });

  it("'approaching' when currentMiles/limit >= 0.75", () => {
    const runs = [run(2, 10), run(9, 10)]; // 20 mi / 4 = 5 mi/wk
    const p = projectShoeReplacement(
      { currentMiles: 300, limit: 400 }, // 0.75 exactly → approaching
      runs,
      NOW,
    )!;
    expect(p.state).toBe("approaching");
    expect(p.milesRemaining).toBe(100);
    expect(p.projectedDate).not.toBeNull();
  });

  it("stays 'ok' just below the 0.75 threshold", () => {
    const p = projectShoeReplacement(
      { currentMiles: 299, limit: 400 }, // 0.7475 < 0.75
      [run(1, 10)],
      NOW,
    )!;
    expect(p.state).toBe("ok");
  });

  it("'over' when currentMiles >= limit: null date, miles clamps at 0", () => {
    const p = projectShoeReplacement(
      { currentMiles: 420, limit: 400 },
      [run(1, 10)],
      NOW,
    )!;
    expect(p.state).toBe("over");
    expect(p.projectedDate).toBeNull();
    expect(p.milesRemaining).toBe(0); // max(400-420,0)
  });

  it("'over' exactly at the limit", () => {
    const p = projectShoeReplacement(
      { currentMiles: 400, limit: 400 },
      [run(1, 10)],
      NOW,
    )!;
    expect(p.state).toBe("over");
    expect(p.projectedDate).toBeNull();
  });

  it("'inactive' with no recent miles: null date, no divide-by-zero", () => {
    // Only an old run (60d ago) → outside the 28d window → rate 0.
    const p = projectShoeReplacement(
      { currentMiles: 100, limit: 400 },
      [run(60, 30)],
      NOW,
    )!;
    expect(p.state).toBe("inactive");
    expect(p.recentMilesPerWeek).toBe(0);
    expect(p.projectedDate).toBeNull();
    expect(Number.isFinite(p.recentMilesPerWeek)).toBe(true);
  });

  it("'inactive' when the shoe has no runs at all", () => {
    const p = projectShoeReplacement(
      { currentMiles: 50, limit: 400 },
      [],
      NOW,
    )!;
    expect(p.state).toBe("inactive");
    expect(p.projectedDate).toBeNull();
    expect(p.milesRemaining).toBe(350);
  });

  it("28-day window: includes a run exactly 28 days ago, excludes one just beyond", () => {
    const included = projectShoeReplacement(
      { currentMiles: 100, limit: 400 },
      [run(28, 12)], // exactly at the boundary → included
      NOW,
    )!;
    expect(included.recentMilesPerWeek).toBe(3); // 12 / 4
    expect(included.state).toBe("ok");

    const excluded = projectShoeReplacement(
      { currentMiles: 100, limit: 400 },
      [{ dateISO: new Date(NOW.getTime() - 28 * DAY - 1).toISOString(), miles: 12 }],
      NOW,
    )!;
    expect(excluded.recentMilesPerWeek).toBe(0);
    expect(excluded.state).toBe("inactive");
  });

  it("excludes future-dated runs from the recent rate", () => {
    const p = projectShoeReplacement(
      { currentMiles: 100, limit: 400 },
      [run(-3, 50)], // 3 days in the future
      NOW,
    )!;
    expect(p.recentMilesPerWeek).toBe(0);
    expect(p.state).toBe("inactive");
  });

  it("does not mutate the input runs array", () => {
    const runs = [run(1, 10), run(5, 10)];
    const copy = JSON.parse(JSON.stringify(runs));
    projectShoeReplacement({ currentMiles: 100, limit: 400 }, runs, NOW);
    expect(runs).toEqual(copy);
  });
});
