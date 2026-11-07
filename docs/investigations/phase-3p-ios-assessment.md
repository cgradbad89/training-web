# Phase 3P — iOS change assessment for heart-rate-based estimation

**Scope:** interface-contract level only. The iOS app (`cgradbad89/MEA.git`) was neither read, edited, rebuilt nor deployed; everything
below about iOS is inferred from what the web repository documents it uploads (PRD §3) and from observed data. Verdict first:
**no iOS change is required** for the experimental estimate shipped in Phase 3P, and none is a prerequisite for promoting it.

## 1. What Training Web accomplishes with existing data

Using only parent fields already loaded into app context (`avgHeartRate`, duration, distance, dates, `displayType`, `hasRoute`,
`elevationGainM`, `weather`, overrides): a pooled, heart-rate-banded, bounded, uncertainty-shrunk pace-at-comparable-HR contrast against the
race anchor; effort-adjusted (slope with a sensitivity bound); surface/terrain/artifact screens; weather-aware strength; treadmill separated.
Observed 2026-11-07: `avgHeartRate` on 100 % of runs, 12 baseline + 8 recent supporting runs (strict ±3 bpm pairing found 0 pairs).
Cost: zero new Firestore reads, no child-collection reads, no new documents.

## 2. Candidate iOS-derived improvements

| Improvement | Why it matters | Needed? | Notes |
|---|---|---|---|
| **Warm-up-trimmed steady-state average HR** (e.g. mean HR after minute 10, gaps excluded) | The parent `avgHeartRate` is a whole-session mean that includes warm-up (Phase 3L observed: HR in minutes 5–15 exceeds minutes 0–5 by a median 9.3 bpm). It biases short runs low, so a change in typical run length alters apparent pace-at-HR. | **Desirable**, not necessary. Largest single accuracy lever for the signal. | Already derivable web-side from the existing `hrStream` / route `hr`, at child-read cost. |
| **HR drift excluding warm-up, duration-normalized** | The stored `hrDriftPct` includes warm-up, depends on duration and has rare ±40 % artifacts. A trimmed, windowed variant could supply a fatigue/effort-consistency screen. | Desirable; **not used** by the estimator until it exists and is validated. | Compute as (mean HR last third − mean HR middle third)/middle third over the post-warm-up span; refuse < 25 min. |
| **HR time-series quality flags** (`hrCoveragePct`, `hrMaxGapSeconds`, `hrSampleCount`) | Distinguishes sensor dropouts and lock-on lag from real effort; lets the web reject runs with unreliable HR instead of inferring it from pace/HR residuals. | Desirable. | Phase 3L: artifacts concentrate in streams with 8–16-minute holes. |
| **Resting / max HR provenance** | The web reads `resting_hr` from daily `healthMetrics` and `maxHeartRate`/`restingHeartRate` from user settings (current values, retroactive). Provenance and as-of values would make %HRR-based work reproducible. | Not needed: the shipped signal uses raw bpm and never reads them. Needed only if a future model uses %HRR. | Prefer storing the value used on the day, not changing history. |
| **Workout intensity / structure classification** (steady vs intervals) | The estimator relies on `displayType` words and duration to find steady runs. A device-side label would reduce misclassified hard efforts. | Desirable. | A structural measure from the HR/pace stream (variance) is computable web-side. |
| **Data uploaded but unused by the web** | `hrStream` (per-sample HR), route-point `hr`, `mileSplits.avgBpm`, `cadenceSPM`, `hrDriftPct`, daily `resting_hr` all exist. | — | The cheapest path to a trimmed steady-state HR is to read them for a *bounded* set of candidate runs and cache the scalar on the parent (below). |

## 3. Proposed upload contract (if the owner later wants it)

Optional, additive, absent on legacy documents (readers must treat absence as "not computed"). Three to five numbers on the existing parent
document, written in the same sync write that already sets `avgHeartRate`:

```
hrSteady: {                    // all optional; version bumps are explicit
  version: 1,
  avgBpm: number,              // mean HR after minute 10, gaps excluded
  windowSeconds: number,       // seconds of HR actually averaged
  coveragePct: number,         // 0–100: share of the post-warm-up span with a sample within 30 s
  maxGapSeconds: number,
  driftPct: number | null      // trimmed, duration-normalized; null when the run is too short
}
```

**Storage / write implications:** ≈ 5 numbers × ~130 runs per year ≈ 650 numbers per year on documents that already exist; **no new
writes** if folded into the existing parent write, no new collection, no index, and no new Firestore rule (same owner write path). Reads:
unchanged (parent fields already loaded everywhere). Backfill of history would be a one-off iOS run over existing HealthKit samples.

## 4. Is web-only computation preferable?

* **Web-only, no iOS change (viable, recommended first):** read `hrStream` for only the runs the signal actually uses (~20–40 steady
  outdoor runs per anchor), compute the trimmed mean once, and cache it on the parent with an owner merge-write — the same pattern as
  `routeClusterId`, `bestEfforts` and `weather`, which already exist and need no new rule. Cost: one bounded burst of chunk reads per
  run, once. Chunk sizes were not measured in this phase; measure before choosing this path.
* **iOS-derived (preferable long-term):** one consistent definition at the source, no read burst, no web write, reproducible history,
  and free quality flags. It requires an iOS release and a backfill, both outside this repository.
* **Recommendation:** do neither now. The experimental estimate is limited today by *volume and noise*, not by HR definition (≈ 4.8 %
  run-level noise, 12/8 supporting runs, 38 % weather coverage). Revisit after the March 20, 2027 outcome and ≥ 5 independent outcomes; if
  steady-state HR is then shown to be the binding error, prefer the iOS field, with the web-only cache as the stopgap.

## 5. What was not verified

* iOS behaviour: not inspected (out of scope). Chunk sizes/sampling rates of `hrStream`: not measured. No iOS modification was proposed as
  a prerequisite for anything shipped.
