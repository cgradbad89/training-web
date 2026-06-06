import { describe, it, expect } from "vitest";
import { formatMonthYear } from "@/utils/dates";

describe("formatMonthYear", () => {
  it("formats as full month name + year", () => {
    // Local-time constructor (month is 0-indexed): March 11, 2027.
    expect(formatMonthYear(new Date(2027, 2, 11))).toBe("March 2027");
    expect(formatMonthYear(new Date(2026, 11, 1))).toBe("December 2026");
  });
});
