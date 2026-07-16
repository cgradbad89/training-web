import { describe, it, expect } from "vitest";
import { buildVo2History } from "./vo2History";

describe("buildVo2History", () => {
  it("handles no qualifying vo2_max entries", () => {
    const rawDocs = [
      { id: "2024-01-01", data: { date: "2024-01-01", vo2_max: 0 } },
      { id: "2024-01-02", data: { date: "2024-01-02" } }, // missing vo2_max entirely
    ];
    const result = buildVo2History(rawDocs);
    expect(result.length).toBe(0);
  });

  it("handles normal case and sorts by date", () => {
    const rawDocs = [
      { id: "2024-01-03", data: { date: "2024-01-03", vo2_max: 42.5 } },
      { id: "2024-01-01", data: { date: "2024-01-01", vo2_max: 40.0 } },
      { id: "2024-01-02", data: { vo2_max: 41.0 } }, // relies on id fallback
    ];
    const result = buildVo2History(rawDocs);
    
    expect(result).toEqual([
      { date: "2024-01-01", value: 40.0 },
      { date: "2024-01-02", value: 41.0 },
      { date: "2024-01-03", value: 42.5 },
    ]);
  });
});
