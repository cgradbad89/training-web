/**
 * Tests for the run-quality audit (scripts/auditRunQuality.ts):
 *  - a small, focused unit suite for the PURE classifier (runs in `npm test`);
 *  - an env-gated live smoke test that hits Firestore (skipped by default, same
 *    pattern as the backfill runner). Enable:
 *      AUDIT=1 AUDIT_REPORT=/tmp/audit_report.txt npx vitest run scripts/auditRunQuality.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  classifyRunFlags,
  runAuditRunQuality,
  ALL_FLAGS,
} from "./auditRunQuality";

// ── PURE classifier (no Firestore) — focused matrix, intentionally not exhaustive.
describe("classifyRunFlags — run-quality flag matrix", () => {
  const base = {
    activityType: "running",
    distanceMiles: 5,
    durationSeconds: 1800,
    avgHeartRate: 150,
    hasRoute: true,
    hasHRStream: true,
    mileSplitsCount: 5,
    storedLoad: 100 as number | null,
    storedMethod: "streamed" as string | undefined,
    recomputedLoad: 100 as number | null,
    avgHrFallbackLoad: 100 as number | null,
  };

  it("a healthy run → no flags", () => {
    expect(classifyRunFlags(base)).toEqual([]);
  });

  it("STALE_LOAD: streamed stored far below the fresh recompute", () => {
    expect(
      classifyRunFlags({ ...base, storedLoad: 14, recomputedLoad: 187 })
    ).toContain("STALE_LOAD");
  });

  it("COLLAPSED_LOAD: stored < 0.3× avg-HR reference and NOT stale", () => {
    const flags = classifyRunFlags({
      ...base,
      storedLoad: 20,
      recomputedLoad: 20, // recompute agrees → not stale
      avgHrFallbackLoad: 100,
    });
    expect(flags).toContain("COLLAPSED_LOAD");
    expect(flags).not.toContain("STALE_LOAD");
  });

  it("MISSING_LOAD: null stored load but HR present", () => {
    expect(
      classifyRunFlags({
        ...base,
        storedLoad: null,
        storedMethod: undefined,
        recomputedLoad: 90,
      })
    ).toContain("MISSING_LOAD");
  });

  it("MISSING_ROUTE: running > 0.5mi but hasRoute false", () => {
    expect(classifyRunFlags({ ...base, hasRoute: false })).toContain(
      "MISSING_ROUTE"
    );
  });

  it("MISSING_SPLITS: route run > 5min with zero mileSplits docs", () => {
    expect(classifyRunFlags({ ...base, mileSplitsCount: 0 })).toContain(
      "MISSING_SPLITS"
    );
  });

  it("MISSING_HRSTREAM: route run without an hrStream", () => {
    expect(classifyRunFlags({ ...base, hasHRStream: false })).toContain(
      "MISSING_HRSTREAM"
    );
  });

  it("a run can earn multiple flags at once", () => {
    const flags = classifyRunFlags({
      ...base,
      hasRoute: false,
      storedLoad: null,
      storedMethod: undefined,
      recomputedLoad: null,
    });
    expect(flags).toContain("MISSING_ROUTE");
    expect(flags).toContain("MISSING_LOAD");
  });
});

// ── LIVE smoke test — env-gated; skipped in normal `npm test`. ───────────────
const AUDIT = process.env.AUDIT;
it.skipIf(!AUDIT)(
  "runAuditRunQuality returns a structured summary (flagCounts + cleanCount)",
  async () => {
    const s = await runAuditRunQuality({ uid: process.env.AUDIT_UID });
    expect(typeof s.cleanCount).toBe("number");
    expect(typeof s.totalRunLike).toBe("number");
    expect(s.flagCounts).toBeTypeOf("object");
    for (const f of ALL_FLAGS) expect(typeof s.flagCounts[f]).toBe("number");
    expect(Array.isArray(s.flaggedRows)).toBe(true);
    expect(Array.isArray(s.staleDocIds)).toBe(true);
    expect(Array.isArray(s.missingLoadDocIds)).toBe(true);
  },
  600_000
);
