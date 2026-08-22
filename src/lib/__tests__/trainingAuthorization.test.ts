import { describe, expect, it } from "vitest";
import {
  isAuthorizedTrainingUser,
  TRAINING_WEB_OWNER_EMAIL,
} from "@/lib/trainingAuthorization";

describe("isAuthorizedTrainingUser", () => {
  it.each([
    [TRAINING_WEB_OWNER_EMAIL, true, true],
    ["FoLsTrOmJoHn@GmAiL.CoM", true, true],
    ["  folstromjohn@gmail.com  ", true, true],
    [TRAINING_WEB_OWNER_EMAIL, false, false],
    [TRAINING_WEB_OWNER_EMAIL, null, false],
    ["another@example.com", true, false],
    [null, true, false],
    [undefined, true, false],
  ])("authorizes email=%s verified=%s as %s", (email, verified, expected) => {
    expect(isAuthorizedTrainingUser(email, verified)).toBe(expected);
  });
});
