import { describe, expect, it } from "vitest";
import { shouldEnrichLoad, enrichBasisKey } from "@/utils/trainingLoad";

// Covers the enrich-on-snapshot decision: which loaded workouts get a stored
// Training Load V2 written / upgraded, and which correctly stay "—".

describe("shouldEnrichLoad — store / upgrade / skip matrix", () => {
  // ── (a) STORE — no stored value, but an HR basis exists ──────────────────
  it("null load + hasRoute → true (STORE)", () => {
    expect(shouldEnrichLoad({ hasRoute: true })).toBe(true);
  });

  it("null load + hasHRStream → true (STORE)", () => {
    expect(shouldEnrichLoad({ hasHRStream: true })).toBe(true);
  });

  it("null load + finite avgHeartRate → true (STORE)", () => {
    expect(shouldEnrichLoad({ avgHeartRate: 150 })).toBe(true);
  });

  it("explicit-null stored load + finite avgHeartRate → true (STORE)", () => {
    expect(
      shouldEnrichLoad({ trainingLoadV2: null, avgHeartRate: 150 })
    ).toBe(true);
  });

  // ── STORE negative — no HR basis yet → must stay "—" ─────────────────────
  it("null load + NO HR basis → false (stays —)", () => {
    expect(shouldEnrichLoad({})).toBe(false);
    expect(shouldEnrichLoad({ avgHeartRate: null })).toBe(false);
    expect(shouldEnrichLoad({ avgHeartRate: 0 })).toBe(false);
    expect(
      shouldEnrichLoad({ hasRoute: false, hasHRStream: false })
    ).toBe(false);
  });

  // ── (b) UPGRADE — stored via avg-HR, richer basis arrived ────────────────
  it("stored 'avg-hr-fallback' + gains hasHRStream → true (UPGRADE)", () => {
    expect(
      shouldEnrichLoad({
        trainingLoadV2: 42,
        trainingLoadMethod: "avg-hr-fallback",
        hasHRStream: true,
      })
    ).toBe(true);
  });

  it("stored 'avg-hr-fallback' + gains hasRoute → true (UPGRADE)", () => {
    expect(
      shouldEnrichLoad({
        trainingLoadV2: 42,
        trainingLoadMethod: "avg-hr-fallback",
        hasRoute: true,
      })
    ).toBe(true);
  });

  // ── Skip — already streamed, or stored with no richer basis ──────────────
  it("stored 'streamed' → false (never re-enriched)", () => {
    expect(
      shouldEnrichLoad({
        trainingLoadV2: 99,
        trainingLoadMethod: "streamed",
        hasHRStream: true,
      })
    ).toBe(false);
  });

  it("stored finite value + no richer basis → false", () => {
    expect(
      shouldEnrichLoad({
        trainingLoadV2: 42,
        trainingLoadMethod: "avg-hr-fallback",
        avgHeartRate: 150,
      })
    ).toBe(false);
  });
});

describe("enrichBasisKey — basis identity for the loop guard", () => {
  it("encodes id + hasRoute + hasHRStream", () => {
    expect(
      enrichBasisKey({ workoutId: "w1", hasRoute: true, hasHRStream: false })
    ).toBe("w1|true|false");
  });

  it("treats missing flags as false", () => {
    expect(enrichBasisKey({ workoutId: "w2" })).toBe("w2|false|false");
  });

  it("changes when a stream arrives (so the one UPGRADE pass is allowed through)", () => {
    const before = enrichBasisKey({ workoutId: "w3", hasHRStream: false });
    const after = enrichBasisKey({ workoutId: "w3", hasHRStream: true });
    expect(before).not.toBe(after);
  });

  it("is stable for an unchanged basis (so the same attempt isn't repeated → no loop)", () => {
    expect(enrichBasisKey({ workoutId: "w4", hasRoute: true })).toBe(
      enrichBasisKey({ workoutId: "w4", hasRoute: true })
    );
  });
});
