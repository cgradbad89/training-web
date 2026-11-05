// @vitest-environment node
import { expect, it } from "vitest";
import { runValidationFiles } from "../tools/race-validation/offline";

it.skipIf(!process.env.PHASE3D_MODE)("runs the explicitly requested local half-marathon validation operation", () => {
  const { PHASE3D_MODE, PHASE3D_INPUT, PHASE3D_OUTPUT, PHASE3D_CUSTODY, PHASE3D_MARKDOWN } = process.env;
  if (!PHASE3D_MODE || !PHASE3D_INPUT || !PHASE3D_OUTPUT) {
    throw new TypeError("Set PHASE3D_MODE, PHASE3D_INPUT and PHASE3D_OUTPUT to explicit local paths and mode");
  }
  expect(runValidationFiles({
    mode: PHASE3D_MODE, input: PHASE3D_INPUT, output: PHASE3D_OUTPUT,
    custody: PHASE3D_CUSTODY, markdown: PHASE3D_MARKDOWN,
  })).toHaveProperty("protocol", "half-marathon-validation-v1");
});
