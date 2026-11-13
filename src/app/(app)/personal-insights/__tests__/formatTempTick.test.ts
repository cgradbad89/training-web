import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTempTick } from "../formatTempTick";

describe("formatTempTick", () => {
  it("formats 58 as 58°F with exactly one degree symbol", () => {
    expect(formatTempTick(58)).toBe("58°F");
    expect(formatTempTick(58).match(/°/g)).toHaveLength(1);
  });

  it("rounds to whole degrees", () => {
    expect(formatTempTick(57.6)).toBe("58°F");
    expect(formatTempTick(72.4)).toBe("72°F");
  });

  it("handles zero and negative temperatures", () => {
    expect(formatTempTick(-0.4)).toBe("0°F");
    expect(formatTempTick(-3.4)).toBe("-3°F");
  });
});

describe("weather chart x-axes", () => {
  // Recharts appends an axis `unit` after the tick formatter's output, so the
  // formatter is the single source of "°F" and the axis must not set `unit`.
  for (const file of ["PaceTemperatureChart.tsx", "HeartRateTemperatureChart.tsx"]) {
    it(`${file} uses formatTempTick and sets no °F unit`, () => {
      const src = readFileSync(join(__dirname, "..", file), "utf8");
      expect(src).toContain("tickFormatter={formatTempTick}");
      expect(src).not.toMatch(/unit="°F"/);
    });
  }
});
