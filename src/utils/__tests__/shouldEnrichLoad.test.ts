import { describe, expect, it } from "vitest";
import {
  shouldEnrichLoad,
  enrichBasisKey,
  computeStreamedTrainingLoad,
  computeTrainingLoadV2,
  STREAMED_LOAD_RELATIVE_THRESHOLD,
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

// ── Before PRD §6 #26 a SEVERE partial (a few minutes of a long run) produced a
//    low "streamed" score that only #23's post-completion RECOMPUTE later restored.
//    The relative collapse guard now rescues such severe partials to the avg-HR
//    reference IMMEDIATELY (interim value), and the completed stream computes the
//    real streamed value. (Substantial partials that clear the 0.35 floor still stay
//    "streamed" and ride the #23 basisComplete path — see computeAndStoreTrainingLoad.)
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

  it("severe partial is rescued to the avg-HR reference (relative guard, PRD §6 #26); complete stream computes it as 'streamed'", () => {
    const partial = computeStreamedTrainingLoad(
      partialStream, 5400, 145, maxHr, restingHr, "running"
    );
    const full = computeStreamedTrainingLoad(
      fullStream, 5400, 145, maxHr, restingHr, "running"
    );
    // Severe partial (6 min of a 90-min run): the streamed integral collapses far
    // below 0.35× the avg-HR reference, so the relative guard rescues it — method
    // "avg-hr-fallback" at the full-run avg-HR value (~193), NOT a collapsed ~13.
    expect(partial.method).toBe("avg-hr-fallback");
    expect(partial.load!).toBeGreaterThan(150);
    // The complete stream integrates to the real streamed value (~193).
    expect(full.method).toBe("streamed");
    expect(full.load!).toBeGreaterThan(150);
    // The interim rescue already matches the eventual complete value (~193).
    expect(Math.abs(partial.load! - full.load!)).toBeLessThanOrEqual(15);
  });
});

describe("enrichBasisKey — basis identity for the loop guard", () => {
  it("encodes id + hasRoute + hasHRStream + routeComplete + loadBand", () => {
    expect(
      enrichBasisKey({ workoutId: "w1", hasRoute: true, hasHRStream: false })
    ).toBe("w1|true|false|false|0"); // GPS run → band always 0
  });

  it("treats missing flags as false", () => {
    expect(enrichBasisKey({ workoutId: "w2" })).toBe("w2|false|false|false|0");
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
    expect(complete).toBe("w5|true|false|true|0");
  });

  it("is stable for an unchanged basis (so the same attempt isn't repeated → no loop)", () => {
    expect(
      enrichBasisKey({ workoutId: "w4", hasRoute: true, routeComplete: true })
    ).toBe(enrichBasisKey({ workoutId: "w4", hasRoute: true, routeComplete: true }));
  });
});

// ── (d) NON-ROUTE stale-load recompute (PRD §6 #27) — OTF/HIIT/strength/mindful
//        have no routeComplete signal, so a two-pass hrStream sync (or a pre-
//        relative-guard legacy collapse) leaves a stale "streamed" load with no way
//        to recompute. Branch (d) detects it (stored < 35% of the avg-HR reference)
//        and allows ONE recompute; the enrichBasisKey load band stops re-triggering.
describe("shouldEnrichLoad — (d) non-route stale streamed load", () => {
  // OTF profile: 45 min @ 155 bpm; anchors → avg-HR reference ≈ 119 ("~120").
  const MX = 180;
  const RST = 60;
  const DUR = 2700;
  const AVG = 155;
  const otf = {
    hasRoute: false,
    hasHRStream: true,
    trainingLoadMethod: "streamed" as const,
    avgHeartRate: AVG,
    durationSeconds: DUR,
  };

  it("non-route OTF with a stale streamed load (< 35% of avg-HR ref) → branch (d) fires", () => {
    const ref = computeTrainingLoadV2(DUR, AVG, MX, RST) as number;
    expect(ref).toBeGreaterThan(100); // OTF reference ≈ 120
    const stale = { ...otf, trainingLoadV2: 30 }; // collapsed ~25%
    expect(stale.trainingLoadV2).toBeLessThan(ref * STREAMED_LOAD_RELATIVE_THRESHOLD);
    expect(shouldEnrichLoad(stale, MX, RST)).toBe(true);
  });

  it("after recompute the load is ≥ 35% of ref → branch (d) does NOT fire (no thrash)", () => {
    const ref = computeTrainingLoadV2(DUR, AVG, MX, RST) as number;
    const recomputed = { ...otf, trainingLoadV2: ref }; // corrected to the avg-HR value
    expect(recomputed.trainingLoadV2).toBeGreaterThanOrEqual(
      ref * STREAMED_LOAD_RELATIVE_THRESHOLD
    );
    expect(shouldEnrichLoad(recomputed, MX, RST)).toBe(false);
  });

  it("enrichBasisKey load band flips 0→1+ when the stale load is corrected (stable once correct)", () => {
    const ref = computeTrainingLoadV2(DUR, AVG, MX, RST) as number;
    const base = { ...otf, workoutId: "otf1" };
    const staleKey = enrichBasisKey({ ...base, trainingLoadV2: 30 }, MX, RST);
    const correctKey = enrichBasisKey({ ...base, trainingLoadV2: ref }, MX, RST);
    expect(staleKey.endsWith("|0")).toBe(true); // stale → band 0
    expect(correctKey.endsWith("|0")).toBe(false); // correct → band 1+
    expect(staleKey).not.toBe(correctKey); // key changes → one recompute allowed
    // Stable once correct → the per-basis guard won't re-queue it.
    expect(enrichBasisKey({ ...base, trainingLoadV2: ref }, MX, RST)).toBe(correctKey);
  });

  it("GPS run (hasRoute=true) with a tiny load → branch (d) never fires (GPS path unchanged)", () => {
    // Low streamed load but no completion signal: (c) can't fire, and (d) is gated
    // on hasRoute !== true → skipped. GPS recompute stays exclusively the (c) path.
    const gps = {
      hasRoute: true,
      hasHRStream: true,
      trainingLoadMethod: "streamed" as const,
      avgHeartRate: AVG,
      durationSeconds: DUR,
      trainingLoadV2: 5,
    };
    expect(shouldEnrichLoad(gps, MX, RST)).toBe(false);
    expect(
      enrichBasisKey({ ...gps, workoutId: "gps1" }, MX, RST).endsWith("|0")
    ).toBe(true); // GPS → band always 0
  });

  it("non-route avg-hr-fallback (no richer basis) → branch (d) does NOT fire (only 'streamed' triggers)", () => {
    const ref = computeTrainingLoadV2(DUR, AVG, MX, RST) as number;
    // hasHRStream=false isolates (d): (b) UPGRADE can't fire (no richer basis), so a
    // `false` result proves the method gate — a fallback value is already correct.
    const fallback = {
      hasRoute: false,
      hasHRStream: false,
      trainingLoadMethod: "avg-hr-fallback" as const,
      avgHeartRate: AVG,
      durationSeconds: DUR,
      trainingLoadV2: 10,
    };
    expect(fallback.trainingLoadV2).toBeLessThan(ref * STREAMED_LOAD_RELATIVE_THRESHOLD);
    expect(shouldEnrichLoad(fallback, MX, RST)).toBe(false);
  });
});
