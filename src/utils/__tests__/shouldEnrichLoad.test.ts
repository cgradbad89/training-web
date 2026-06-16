import { describe, expect, it } from "vitest";
import {
  shouldEnrichLoad,
  enrichBasisKey,
  computeStreamedTrainingLoad,
} from "@/utils/trainingLoad";

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

  // ── Skip — already streamed (complete basis), or stored w/ no richer basis ─
  it("stored 'streamed' (no completion signal) → false (never re-enriched)", () => {
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

// ── (c) RECOMPUTE — two-pass sync: a "streamed" load computed on a PARTIAL route
//        must recompute once the route completes; healthy/complete loads must not.
describe("shouldEnrichLoad — (c) post-completion recompute of a streamed load", () => {
  const collapsed = {
    trainingLoadV2: 14,
    trainingLoadMethod: "streamed" as const,
    hasRoute: true,
  };

  it("streamed + routeComplete=true + basisComplete=false → true (the 6/16 case)", () => {
    expect(
      shouldEnrichLoad({ ...collapsed, routeComplete: true, trainingLoadBasisComplete: false })
    ).toBe(true);
  });

  it("streamed + routeComplete=true + basisComplete=true → false (healthy, no thrash)", () => {
    expect(
      shouldEnrichLoad({
        trainingLoadV2: 187,
        trainingLoadMethod: "streamed",
        hasRoute: true,
        routeComplete: true,
        trainingLoadBasisComplete: true,
      })
    ).toBe(false);
  });

  it("streamed + routeComplete=true + basisComplete absent (legacy) → false (no deploy burst)", () => {
    expect(
      shouldEnrichLoad({ ...collapsed, routeComplete: true })
    ).toBe(false);
  });

  it("streamed + routeComplete=false (still syncing) + basisComplete=false → false (wait for completion)", () => {
    expect(
      shouldEnrichLoad({ ...collapsed, routeComplete: false, trainingLoadBasisComplete: false })
    ).toBe(false);
  });

  it("streamed + routeComplete absent + basisComplete=false → false (no completion signal)", () => {
    expect(
      shouldEnrichLoad({ ...collapsed, trainingLoadBasisComplete: false })
    ).toBe(false);
  });
});

// ── The underlying collapse → repair the recompute trigger relies on: the SAME
//    workout's streamed score is far higher once the full route has landed.
describe("two-pass collapse — partial vs complete streamed score", () => {
  const START = Date.parse("2026-06-16T12:00:00Z");
  const maxHr = 175;
  const restingHr = 65;
  // Clean ~1 Hz run at 145 bpm for 90 min (5400 samples).
  const fullStream = Array.from({ length: 5400 }, (_, i) => ({
    timestamp: new Date(START + i * 1000).toISOString(),
    hr: 145,
  }));
  // Mid-sync PARTIAL state: only the first ~6 minutes had landed.
  const partialStream = fullStream.slice(0, 360);

  it("partial extent collapses the score; completed extent restores it (new ≫ old)", () => {
    const partial = computeStreamedTrainingLoad(
      partialStream, 5400, 145, maxHr, restingHr, "running"
    );
    const full = computeStreamedTrainingLoad(
      fullStream, 5400, 145, maxHr, restingHr, "running"
    );
    expect(partial.method).toBe("streamed");
    expect(full.method).toBe("streamed");
    expect(partial.load!).toBeLessThan(25); // 6/16-class collapse (~13)
    expect(full.load!).toBeGreaterThan(150); // correct value (~193)
    expect(full.load!).toBeGreaterThan(partial.load! * 5);
  });
});

describe("enrichBasisKey — basis identity for the loop guard", () => {
  it("encodes id + hasRoute + hasHRStream + routeComplete", () => {
    expect(
      enrichBasisKey({ workoutId: "w1", hasRoute: true, hasHRStream: false })
    ).toBe("w1|true|false|false");
  });

  it("treats missing flags as false", () => {
    expect(enrichBasisKey({ workoutId: "w2" })).toBe("w2|false|false|false");
  });

  it("changes when a stream arrives (so the one UPGRADE pass is allowed through)", () => {
    const before = enrichBasisKey({ workoutId: "w3", hasHRStream: false });
    const after = enrichBasisKey({ workoutId: "w3", hasHRStream: true });
    expect(before).not.toBe(after);
  });

  it("changes when the route COMPLETES (partial → complete two-pass sync)", () => {
    const partial = enrichBasisKey({ workoutId: "w5", hasRoute: true, routeComplete: false });
    const complete = enrichBasisKey({ workoutId: "w5", hasRoute: true, routeComplete: true });
    expect(partial).not.toBe(complete);
    expect(complete).toBe("w5|true|false|true");
  });

  it("is stable for an unchanged basis (so the same attempt isn't repeated → no loop)", () => {
    expect(
      enrichBasisKey({ workoutId: "w4", hasRoute: true, routeComplete: true })
    ).toBe(enrichBasisKey({ workoutId: "w4", hasRoute: true, routeComplete: true }));
  });
});
