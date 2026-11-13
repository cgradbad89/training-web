import { describe, it, expect } from "vitest";
import { resolvePlanStartDate } from "@/utils/planDateEdit";
import { toLocalIsoDate } from "@/utils/dates";

describe("resolvePlanStartDate (F9: no current-year guessing)", () => {
  it("parses startDate as LOCAL midnight (Rock and Roll plan, 2026-09-28)", () => {
    const d = resolvePlanStartDate({ startDate: "2026-09-28" })!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 8, 28, 0]);
  });
  it("a December start stays in its own year even when viewed in January 2027", () => {
    const d = resolvePlanStartDate({ startDate: "2026-12-28" })!;
    expect(toLocalIsoDate(d)).toBe("2026-12-28");
  });
  it("missing plan / missing startDate / invalid startDate → null, never throws", () => {
    expect(resolvePlanStartDate(null)).toBeNull();
    expect(resolvePlanStartDate(undefined)).toBeNull();
    expect(resolvePlanStartDate({})).toBeNull();
    expect(resolvePlanStartDate({ startDate: "" })).toBeNull();
    expect(resolvePlanStartDate({ startDate: "garbage" })).toBeNull();
  });
  it("ignores a week label entirely (no label+year fallback)", () => {
    const plan = { weeks: [{ weekNumber: 1, startDateLabel: "Dec 28" }] } as unknown as { startDate?: string };
    expect(resolvePlanStartDate(plan)).toBeNull();
  });
});
