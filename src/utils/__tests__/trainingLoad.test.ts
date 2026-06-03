import { describe, expect, it } from "vitest";

import {
  computeTrainingLoad,
  DEFAULT_MAX_HR,
  resolveMaxHr,
} from "@/utils/trainingLoad";
import { type UserSettings } from "@/types/userSettings";

describe("training load max HR", () => {
  it("uses a custom max HR when computing zone allocation", () => {
    const defaultLoad = computeTrainingLoad(3600, 160, "Running");
    const customLoad = computeTrainingLoad(3600, 160, "Running", 175);

    expect(defaultLoad).toBe(240);
    expect(customLoad).toBe(390);
  });

  it("resolves profile max HR with the default fallback", () => {
    expect(
      resolveMaxHr({ maxHeartRate: 178 } as UserSettings)
    ).toBe(178);
    expect(resolveMaxHr(null)).toBe(DEFAULT_MAX_HR);
    expect(resolveMaxHr(undefined)).toBe(DEFAULT_MAX_HR);
  });
});
