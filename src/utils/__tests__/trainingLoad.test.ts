import { describe, expect, it } from "vitest";

import {
  computeTrainingLoad,
  DEFAULT_MAX_HR,
  hrAnchorsChanged,
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

describe("hrAnchorsChanged — settings recompute trigger", () => {
  it("fires when maxHeartRate changes", () => {
    expect(
      hrAnchorsChanged(
        { maxHeartRate: 164, restingHeartRate: 60 },
        { maxHeartRate: 180, restingHeartRate: 60 }
      )
    ).toBe(true);
  });

  it("fires when restingHeartRate changes", () => {
    expect(
      hrAnchorsChanged(
        { maxHeartRate: 164, restingHeartRate: 60 },
        { maxHeartRate: 164, restingHeartRate: 65 }
      )
    ).toBe(true);
  });

  it("fires when both change", () => {
    expect(
      hrAnchorsChanged(
        { maxHeartRate: 164, restingHeartRate: 60 },
        { maxHeartRate: 180, restingHeartRate: 65 }
      )
    ).toBe(true);
  });

  it("fires when a value goes from undefined to a number", () => {
    expect(
      hrAnchorsChanged(
        { maxHeartRate: undefined, restingHeartRate: 60 },
        { maxHeartRate: 180, restingHeartRate: 60 }
      )
    ).toBe(true);
    // …and number → undefined (anchor cleared) is also a change.
    expect(
      hrAnchorsChanged(
        { maxHeartRate: 180, restingHeartRate: 60 },
        { maxHeartRate: undefined, restingHeartRate: 60 }
      )
    ).toBe(true);
  });

  it("does NOT fire when neither anchor changes", () => {
    expect(
      hrAnchorsChanged(
        { maxHeartRate: 164, restingHeartRate: 60 },
        { maxHeartRate: 164, restingHeartRate: 60 }
      )
    ).toBe(false);
    // Both unset on each side → no change.
    expect(hrAnchorsChanged({}, {})).toBe(false);
  });
});
