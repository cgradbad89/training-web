// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSyntheticImportGraph } from "./syntheticSafety";
import { assertHarnessExcludedFromApplication } from "./safety";

describe("synthetic preview runtime isolation", () => {
  it("audits the complete standalone entry through the real editor and pure helpers", () => {
    const files = assertSyntheticImportGraph(process.cwd());
    expect(files).toContain("src/components/races/RaceConfirmationEditor.tsx");
    expect(files).toContain("src/utils/raceConfirmation.ts");
    expect(files).toContain("src/utils/racePerformance.ts");
  });

  it("has no Next route or application import and is excluded from the Next typecheck", () => {
    expect(() => assertHarnessExcludedFromApplication(process.cwd())).not.toThrow();
    expect(fs.existsSync("src/app/race-confirmation-preview/page.tsx")).toBe(false);
    expect(fs.existsSync("src/app/(app)/race-confirmation-preview/page.tsx")).toBe(false);
    const config = JSON.parse(fs.readFileSync("tsconfig.build.json", "utf8"));
    expect(config.exclude).toContain("tools/race-performance-acceptance/**");
  });
});
