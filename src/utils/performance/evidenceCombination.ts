/**
 * Phase 3V — performance-capacity-v1.1: precision-weighted, two-group combination of demonstrated-performance evidence.
 *
 * Why not just shorten the half-life? In v1 a weight is `quality × 0.5^(age/42) × reliability`, then NORMALISED. Normalising
 * removes the information a weight carries: with one race and nothing else, any age gives it a 100 % share, and a single
 * newer item can only ever trade shares with it at fixed ratios. Aging evidence also never became less *certain*, only
 * lighter. v1.1 replaces the weights by a measurement model:
 *
 *   each item i is an observation of the athlete's half-marathon-equivalent time with an internal uncertainty
 *     σᵢ² = measurementσ(kind)² + extrapolationσ(distance ratio)² + driftσ(age)²         (fractions of time)
 *   - measurementσ: a confirmed race is the most reliable observation of capacity, a recorded race next, then a race-labelled
 *     run, a strong whole-run effort, and a sustained segment (submaximal by construction → largest);
 *   - extrapolationσ = 0.02·|ln(target/source)| for shorter sources (the Riegel exponent is uncertain by ≈ ±0.02) and
 *     0.01·|ln| for longer sources — a 5 K says much less about a half marathon than a 10 mi does;
 *   - driftσ = 1 %·√(age/30 d): true capacity is a random walk, so an old result is a LESS CERTAIN observation of today's
 *     capacity (the same prior spread the physiological term and the race-day forecast already use). It does not make the
 *     result faster or slower. With no newer evidence the old race is still the best point estimate; only its uncertainty grows.
 *
 * Items are pooled in two groups — races, and newer efforts (whole-run, race-labelled, segments). Within a group items are
 * inverse-variance weighted; each group also carries a COMMON-MODE term (1 % races, 1.5 % efforts) that does not average out:
 * submaximal effort and unmodelled conditions are shared across a training block, so five easy-ish efforts are not five
 * independent measurements. The two groups are then precision-weighted. Consequences, none of them hard-coded:
 *   • a race is re-weighted continuously as it ages and as newer, credible, mutually consistent evidence accumulates;
 *   • a lone newer effort cannot displace a race (its precision is low, and an uncorroborated one is inflated further);
 *   • with no newer evidence the race keeps 100 % of the base and the estimate does not move;
 *   • newer evidence needs no race: efforts alone suffice when ≥ 2 contemporary items in different weeks exist.
 * Evidence asymmetry: an UNCONFIRMED effort is a lower bound on capability (a submaximal effort looks slower). One slower
 * than the pass-1 estimate keeps its information but with 4× variance; a segment slower than the estimate is ignored (it says
 * nothing). Isolated, uncorroborated items (> 4 % away from everything else with no peer within 3 %) are inflated 1/0.35× in
 * EITHER direction, and a slower lower-bound effort with no peer is inflated regardless of distance. Slower evidence therefore needs independent corroboration to move the estimate, symmetrically with
 * faster evidence, and is weighted less because it is weaker evidence of lost capability.
 *
 * Effective shares reconcile exactly with the calculation: base = exp(Σ shareᵢ·ln eqᵢ), Σ shareᵢ = 1.
 * All constants are ENGINEERING ASSUMPTIONS; none was fitted to a race outcome. The "uncertainty" is an internal weighting
 * quantity, not a calibrated statistical interval.
 */
import type {
  CombinationItem, CombinationItemFlag, CombinationUnavailableCause, EvidenceCombination, EvidenceGroup, EvidenceItemV11,
  GroupSummary, IgnoredItem, RaceDominance,
} from "@/types/hybridPerformanceV11";
import { shiftPerformanceDate } from "@/utils/performanceEvidence";
import { HALF_MARATHON_METERS } from "@/utils/racePerformance";
import { CAPACITY_POLICY, equivalentOf, extrapolationReliability } from "./capacityMethods";

export const COMBINATION_VERSION = "performance-capacity-v1.1" as const;
export const COMBINATION_POLICY = Object.freeze({
  version: COMBINATION_VERSION,
  measurementSigma: { confirmed_race: 0.010, recorded_race: 0.015, labelled_race_run: 0.025, whole_run_effort: 0.030, sustained_segment: 0.035 } as Record<string, number>,
  extrapolationSigmaPerLn: 0.02, longerSourceSigmaPerLn: 0.01, atTargetBand: 1.05,
  driftPerSqrtMonth: 0.01,
  weatherMissingVarianceFactor: 1 / 0.85,
  commonMode: { race: 0.010, recent_effort: 0.015 },
  isolatedMargin: 0.04, isolatedPeerTolerance: 0.03, isolatedVarianceFactor: 1 / 0.35,
  slowerMargin: 0.005, slowerVarianceFactor: 4,
  dominantShare: 0.7, minorShare: 0.3,
  adequateUncertainty: 0.02, minimumItemsWithoutConfirmed: 3,
  differsZ: 1.5,
  contradictoryDispersion: 0.04, contradictorySpread: 0.06,
  contemporaryWindowDays: CAPACITY_POLICY.contemporaryWindowDays, minimumContemporaryItems: CAPACITY_POLICY.minimumContemporaryItems,
  minimumContemporaryWeeks: CAPACITY_POLICY.minimumContemporaryWeeks, minimumReliableExtrapolation: CAPACITY_POLICY.minimumReliableExtrapolation,
});

/** Assumption-sensitivity knobs (all default to the policy). Used only for ranges and research sweeps. */
export interface CombinationParams {
  commonModeRace?: number; commonModeRecent?: number; driftPerSqrtMonth?: number;
  /** Multiplies every measurement σ (1 = policy). */
  measurementScale?: number;
  slowerVarianceFactor?: number;
  /** Drop one kind of evidence (research sweeps). */
  excludeKinds?: readonly string[];
}
export interface CombineOptions { targetDistanceMeters?: number; exponent?: number; expiredItems?: number; params?: CombinationParams }

const isoWeek = (date: string) => shiftPerformanceDate(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const isRace = (k: string) => k === "confirmed_race" || k === "recorded_race";

interface Row {
  item: EvidenceItemV11; group: EvidenceGroup; eq: number; ln: number; ratio: number; reliability: number;
  variance: number; flags: CombinationItemFlag[];
}
const weightedLog = (rows: readonly Row[]) => {
  const p = rows.reduce((s, r) => s + 1 / r.variance, 0);
  return rows.reduce((s, r) => s + r.ln / r.variance, 0) / p;
};

function unavailable(target: number, exponent: number, cause: CombinationUnavailableCause, reason: string, ignored: IgnoredItem[]): EvidenceCombination {
  return { version: COMBINATION_VERSION, method: "precision_weighted_two_group", status: "unavailable", unavailableCause: cause, targetDistanceMeters: target, exponent,
    items: [], ignored, race: null, recent: null, baseSeconds: null, raceOnlySeconds: null, recentOnlySeconds: null, displacementSeconds: null,
    raceShare: 0, recentShare: 0, raceDominance: "none", newerEvidenceMajority: false, latestRaceDate: null, latestRaceAgeDays: null,
    independentObservations: 0, uncertaintyFraction: null, dispersionFraction: null, spreadFraction: 0, quality: "insufficient", flags: [], reasons: [reason] };
}

export function combineEvidence(items: readonly EvidenceItemV11[], options: CombineOptions = {}): EvidenceCombination {
  const P = COMBINATION_POLICY, prm = options.params ?? {};
  const target = options.targetDistanceMeters ?? HALF_MARATHON_METERS;
  const exponent = options.exponent ?? CAPACITY_POLICY.defaultExponent;
  const drift = prm.driftPerSqrtMonth ?? P.driftPerSqrtMonth;
  const scale = prm.measurementScale ?? 1;
  const cm = { race: prm.commonModeRace ?? P.commonMode.race, recent_effort: prm.commonModeRecent ?? P.commonMode.recent_effort };
  const ignored: IgnoredItem[] = [];
  const ignore = (i: EvidenceItemV11, reason: IgnoredItem["reason"]) => ignored.push({ clusterId: i.clusterId, kind: i.kind, date: i.date, reason });

  // 1 ─ equivalents and base uncertainty per item.
  let rows: Row[] = [];
  for (const item of items) {
    if (prm.excludeKinds?.includes(item.kind)) continue;
    if (item.seconds < CAPACITY_POLICY.minimumSourceDurationSeconds) { ignore(item, "source_too_short"); continue; }
    const reliability = extrapolationReliability(item.distanceMeters, target);
    if (reliability < CAPACITY_POLICY.minimumReliability) { ignore(item, "extrapolation_unreliable"); continue; }
    const eq = equivalentOf(item, target, exponent);
    if (!eq) { ignore(item, "equivalent_implausible"); continue; }
    const ratio = target / item.distanceMeters, lnRatio = Math.abs(Math.log(ratio));
    const ext = ratio > P.atTargetBand ? P.extrapolationSigmaPerLn * lnRatio : ratio < 0.8 ?P.longerSourceSigmaPerLn * lnRatio : 0;
    const meas = (P.measurementSigma[item.kind] ?? 0.03) * scale;
    const drf = drift * Math.sqrt(Math.max(0, item.ageDays) / 30);
    const flags: CombinationItemFlag[] = [];
    let variance = meas * meas + ext * ext + drf * drf;
    if (item.weatherMissing && !isRace(item.kind)) { variance *= P.weatherMissingVarianceFactor; flags.push("weather_missing"); }
    rows.push({ item, group: isRace(item.kind) ? "race" : "recent_effort", eq: eq.seconds, ln: Math.log(eq.seconds), ratio, reliability, variance, flags });
  }

  // 2 ─ sufficiency: a race (within the 180-day currency limit, enforced upstream) or contemporary corroborated effort evidence.
  const anchors = rows.filter(r => r.group === "race");
  const contemporary = rows.filter(r => r.group === "recent_effort" && r.item.ageDays <= P.contemporaryWindowDays);
  const contemporaryEnough = contemporary.length >= P.minimumContemporaryItems
    && new Set(contemporary.map(r => isoWeek(r.item.date))).size >= P.minimumContemporaryWeeks
    && contemporary.some(r => r.reliability >= P.minimumReliableExtrapolation);
  if (!anchors.length && !contemporaryEnough) {
    const cause: CombinationUnavailableCause = !items.length ? ((options.expiredItems ?? 0) > 0 ? "anchor_expired_no_contemporary_evidence" : "no_performance_evidence") : "insufficient_independent_evidence";
    const reason = cause === "anchor_expired_no_contemporary_evidence"
      ? "The only qualifying performance is older than 180 days and carries no weight; no strong contemporary evidence replaces it."
      : cause === "no_performance_evidence" ? "No qualifying race, time trial or strong sustained effort is available."
      : "Qualifying evidence is too thin: needs a race within 180 days, or at least two strong efforts in different weeks within 120 days including one that converts reliably to the target distance.";
    return unavailable(target, exponent, cause, reason, ignored);
  }

  // 3 ─ pass 1: pooled estimate with base variances (reference for the asymmetry rules).
  const groupOf = (rs: readonly Row[], g: EvidenceGroup) => rs.filter(r => r.group === g);
  const pooled = (rs: readonly Row[]) => {
    const race = groupOf(rs, "race"), eff = groupOf(rs, "recent_effort");
    const gv = (g: Row[], c: number) => 1 / g.reduce((s, r) => s + 1 / r.variance, 0) + c * c;
    const parts = [race.length ? { ln: weightedLog(race), v: gv(race, cm.race) } : null, eff.length ? { ln: weightedLog(eff), v: gv(eff, cm.recent_effort) } : null].filter(Boolean) as { ln: number; v: number }[];
    const p = parts.reduce((s, x) => s + 1 / x.v, 0);
    return parts.reduce((s, x) => s + x.ln / x.v, 0) / p;
  };
  const e0 = pooled(rows);

  // 4 ─ asymmetry: lower-bound evidence slower than the estimate (segments dropped, others weaker).
  const slowerFactor = prm.slowerVarianceFactor ?? P.slowerVarianceFactor;
  rows = rows.filter(r => {
    if (r.group === "race" || r.ln - e0 <= P.slowerMargin) return true;
    if (r.item.kind === "sustained_segment") { ignore(r.item, "segment_slower_than_estimate"); return false; }
    r.variance *= slowerFactor; r.flags.push("slower_than_estimate_lower_bound"); return true;
  });
  if (!rows.length) return unavailable(target, exponent, "insufficient_independent_evidence", "No usable evidence remains after screening.", ignored);
  // 5 ─ corroboration: an item far from everything else with no peer is inflated, in either direction (races exempt).
  for (const r of rows) {
    if (r.group === "race") continue;
    const others = rows.filter(o => o !== r);
    if (!others.length) continue;
    const po = others.reduce((s, o) => s + 1 / o.variance, 0);
    const meanOthers = others.reduce((s, o) => s + o.ln / o.variance, 0) / po;
    const hasPeer = others.some(o => o.group === "recent_effort" && Math.abs(o.ln - r.ln) <= P.isolatedPeerTolerance);
    // Slower lower-bound evidence ALWAYS needs a peer (a lone slow effort is exactly what a submaximal effort looks like); other
    // evidence needs one only when it is far (> 4 %) from everything else.
    const lowerBoundSlower = r.flags.includes("slower_than_estimate_lower_bound");
    if ((Math.abs(meanOthers - r.ln) > P.isolatedMargin || lowerBoundSlower) && !hasPeer) { r.variance *= P.isolatedVarianceFactor; r.flags.push("isolated_uncorroborated"); }
  }

  // 6 ─ final pooling.
  const race = groupOf(rows, "race"), eff = groupOf(rows, "recent_effort");
  const summary = (rs: Row[], g: EvidenceGroup): { s: GroupSummary; ln: number; prec: number } | null => {
    if (!rs.length) return null;
    const ln = weightedLog(rs), c = cm[g], v = 1 / rs.reduce((s, r) => s + 1 / r.variance, 0) + c * c;
    return { ln, prec: 1 / v, s: { group: g, count: rs.length, share: 0, estimateSeconds: Math.exp(ln), uncertaintyFraction: Math.sqrt(v), commonModeFraction: c } };
  };
  const gr = summary(race, "race"), ge = summary(eff, "recent_effort");
  const G = (gr?.prec ?? 0) + (ge?.prec ?? 0);
  if (gr) gr.s.share = gr.prec / G;
  if (ge) ge.s.share = ge.prec / G;
  const baseLn = ((gr ? gr.prec * gr.ln : 0) + (ge ? ge.prec * ge.ln : 0)) / G;
  const base = Math.exp(baseLn);
  const out: CombinationItem[] = rows.map(r => {
    const g = r.group === "race" ? gr! : ge!, rowsG = r.group === "race" ? race : eff;
    const within = (1 / r.variance) / rowsG.reduce((s, x) => s + 1 / x.variance, 0);
    return { clusterId: r.item.clusterId, kind: r.item.kind, tier: r.item.tier, group: r.group, date: r.item.date, ageDays: r.item.ageDays,
      sourceDistanceMeters: r.item.distanceMeters, sourceSeconds: r.item.seconds, equivalentSeconds: r.eq, extrapolationRatio: r.ratio,
      uncertaintyFraction: Math.sqrt(r.variance), precision: 1 / r.variance, effectiveShare: g.s.share * within, flags: r.flags };
  }).sort((a, b) => b.effectiveShare - a.effectiveShare || a.clusterId.localeCompare(b.clusterId));

  // 7 ─ diagnostics.
  const raceShare = gr?.s.share ?? 0, recentShare = ge?.s.share ?? 0;
  const raceOnly = gr ? gr.s.estimateSeconds : null;
  const latest = race.length ? race.reduce((a, b) => (b.item.ageDays < a.item.ageDays ? b : a)) : null;
  const dominance: RaceDominance = !gr ? "none" : raceShare >= P.dominantShare ? "dominant" : raceShare <= P.minorShare ? "minor" : "shared";
  const withinDispersion = (rs: Row[]) => {
    if (rs.length < 2) return { mad: 0, spread: 0 };
    const w = rs.map(r => 1 / r.variance), tw = w.reduce((a, b) => a + b, 0), m = rs.reduce((s, r, i) => s + r.ln * w[i], 0) / tw;
    return { mad: rs.reduce((s, r, i) => s + Math.abs(r.ln - m) * w[i], 0) / tw, spread: Math.max(...rs.map(r => r.eq)) / Math.min(...rs.map(r => r.eq)) - 1 };
  };
  const dr = withinDispersion(race), de = withinDispersion(eff), all = withinDispersion(rows);
  const contradictory = dr.mad > P.contradictoryDispersion || de.mad > P.contradictoryDispersion || dr.spread > P.contradictorySpread || de.spread > P.contradictorySpread;
  const uncertainty = Math.sqrt(1 / G);
  const hasConfirmed = rows.some(r => r.item.kind === "confirmed_race");
  const adequate = !contradictory && uncertainty <= P.adequateUncertainty && (hasConfirmed || rows.length >= P.minimumItemsWithoutConfirmed);
  const flags: string[] = [];
  if (contradictory) flags.push("contradictory_evidence");
  if (rows.some(r => r.flags.includes("isolated_uncorroborated"))) flags.push("isolated_uncorroborated_effort");
  if (rows.some(r => r.flags.includes("slower_than_estimate_lower_bound"))) flags.push("slower_lower_bound_effort_down_weighted");
  if (ignored.some(i => i.reason === "segment_slower_than_estimate")) flags.push("slower_segment_ignored");
  if (!gr) flags.push("no_race_anchor");
  if (rows.some(r => r.item.ageDays > 120)) flags.push("aging_evidence");
  if (rows.every(r => r.ratio > 1.5)) flags.push("speed_evidence_only");
  if (gr && ge) {
    const z = Math.abs(ge.ln - gr.ln) / Math.sqrt(gr.s.uncertaintyFraction ** 2 + ge.s.uncertaintyFraction ** 2);
    if (z >= P.differsZ) flags.push(ge.ln < gr.ln ? "recent_evidence_faster_than_race" : "recent_evidence_slower_than_race");
  }
  const reasons = [`${rows.length} independent ${rows.length === 1 ? "observation" : "observations"} pooled by precision (${gr ? `races ${(raceShare * 100).toFixed(0)}%` : "no race"}${ge ? `${gr ? ", " : ""}recent efforts ${(recentShare * 100).toFixed(0)}%` : ""}); each carries its own uncertainty, which grows with age and with distance extrapolation.`];
  if (contradictory) reasons.push(`Evidence within a group disagrees (spread ${(Math.max(dr.spread, de.spread) * 100).toFixed(1)}%): treated as provisional.`);
  return { version: COMBINATION_VERSION, method: "precision_weighted_two_group", status: "available", unavailableCause: null, targetDistanceMeters: target, exponent,
    items: out, ignored, race: gr?.s ?? null, recent: ge?.s ?? null, baseSeconds: base, raceOnlySeconds: raceOnly, recentOnlySeconds: ge ? ge.s.estimateSeconds : null,
    displacementSeconds: raceOnly === null ? null : base - raceOnly, raceShare, recentShare, raceDominance: dominance, newerEvidenceMajority: recentShare > 0.5,
    latestRaceDate: latest?.item.date ?? null, latestRaceAgeDays: latest?.item.ageDays ?? null, independentObservations: rows.length,
    uncertaintyFraction: uncertainty, dispersionFraction: rows.length > 1 ? all.mad : null, spreadFraction: all.spread,
    quality: adequate ? "adequate" : "limited", flags: [...new Set(flags)], reasons };
}
