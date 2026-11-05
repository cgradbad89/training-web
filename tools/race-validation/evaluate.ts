import { replayCheckpoint, type Checkpoint } from "./checkpoint";
import {
  PROTOCOL, HORIZONS, checkpointKey, choice, compareKeys, date, instant, key, list, record,
  requireVersion, sha256, string, targetKey,
} from "./evidence";
import { METHODS, MODEL_VERSIONS, type Method } from "./models";
import { readOutcome, type Outcome } from "./outcome";

const LARGE_ERROR_SECONDS = 300;
const SPLITS = ["development", "test"] as const;
const RECEIPT_KINDS = ["checkpoint", "historical_input", "outcome"] as const;
type ReceiptKind = typeof RECEIPT_KINDS[number];

function readCustody(value: unknown) {
  const byDigest = new Map<string, { kind: ReceiptKind; anchoredAt: string; reference: string }>();
  const entries = value === undefined ? [] : list(value, "independent custody catalog");
  for (const item of entries) {
    const row = record(item, "custody entry");
    const digest = sha256(row.digest, "custody.digest");
    if (byDigest.has(digest)) throw new TypeError("Duplicate digest in custody catalog");
    byDigest.set(digest, {
      kind: choice(row.kind, RECEIPT_KINDS, "custody.kind"),
      anchoredAt: instant(row.anchoredAt, "custody.anchoredAt"),
      reference: string(row.reference, "custody.reference"),
    });
  }
  return byDigest;
}

interface ErrorRow {
  predictedSeconds: number | null;
  absoluteErrorSeconds: number | null;
  signedErrorSeconds: number | null;
  reason: string | null;
}

function metrics(rows: ErrorRow[]) {
  const scored = rows.filter(row => row.signedErrorSeconds !== null);
  return {
    attempts: rows.length, predictions: scored.length, abstentions: rows.length - scored.length,
    abstentionRate: rows.length ? (rows.length - scored.length) / rows.length : null,
    meanAbsoluteErrorSeconds: scored.length ? scored.reduce((sum, row) => sum + row.absoluteErrorSeconds!, 0) / scored.length : null,
    signedBiasSeconds: scored.length ? scored.reduce((sum, row) => sum + row.signedErrorSeconds!, 0) / scored.length : null,
    errorsAtLeastFiveMinutes: scored.length ? scored.filter(row => row.absoluteErrorSeconds! >= LARGE_ERROR_SECONDS).length : null,
  };
}

function errorRow(predictedSeconds: number | null, actualSeconds: number, reason: string | null): ErrorRow {
  const signed = predictedSeconds === null ? null : predictedSeconds - actualSeconds;
  return { predictedSeconds, signedErrorSeconds: signed, absoluteErrorSeconds: signed === null ? null : Math.abs(signed), reason };
}

function casesFor(outcomes: Outcome[], checkpoints: ReadonlyMap<string, Checkpoint>, testFromDate: string) {
  return outcomes.flatMap(outcome => HORIZONS.map(horizon => {
    const checkpoint = checkpoints.get(checkpointKey(outcome.target, horizon)) ?? null;
    const heldOut = !!(checkpoint && outcome.workoutId && checkpoint.results.eligibleWorkoutIds.includes(outcome.workoutId));
    const usable = heldOut ? null : checkpoint;
    const actual = outcome.finishSeconds!;
    const errors = usable ? Object.fromEntries(METHODS.map(method => {
      const prediction = usable.results.predictions[method];
      return [method, errorRow(prediction.seconds, actual, prediction.reason)];
    })) as Record<Method, ErrorRow> : null;
    const attribution = usable?.results.attribution ?? null;
    const experimental = errors?.experimental.predictedSeconds;
    // Keep the selected anchor, blend, pairs and eligibility fixed. This is an
    // arithmetic component removal, not a refitted or separately gated model.
    const components = attribution && experimental != null ? {
      noVolumeFrequency: attribution.combinedSeconds - attribution.volumeFrequencySeconds,
      noEndurance: attribution.combinedSeconds - attribution.enduranceSeconds,
      noComparablePace: attribution.combinedSeconds - attribution.comparablePaceSeconds,
      noFreshnessAttenuation: attribution.fixedInputsAdjustmentWithoutFreshnessSeconds,
    } : null;
    const componentErrors = components ? Object.fromEntries(Object.entries(components).map(([name, adjustment]) => [
      name, errorRow(adjustment === null ? null : Math.round((attribution!.anchorSeconds + adjustment) / 60) * 60,
        actual, adjustment === null ? attribution!.freshnessReason : null),
    ])) : null;
    return {
      target: outcome.target, outcomeDigest: outcome.integrityDigest, actualSeconds: actual, horizon,
      split: outcome.target.raceDate < testFromDate ? "development" as const : "test" as const,
      checkpointDigest: checkpoint?.integrityDigest ?? null, capturedAt: checkpoint?.capturedAt ?? null, cutoff: checkpoint?.cutoff ?? null,
      source: checkpoint?.source ?? null, coverage: checkpoint?.coverage ?? null, coverageReasons: checkpoint?.results.coverageReasons ?? [],
      eligibleWorkoutCount: checkpoint?.results.eligibleWorkoutIds.length ?? null,
      inputExclusions: checkpoint ? [...checkpoint.results.inputExclusions, ...checkpoint.results.workoutExclusions] : [],
      featureChecks: checkpoint?.results.featureChecks ?? [], reason: heldOut ? "Held-out outcome workout was eligible in the checkpoint"
        : checkpoint ? null : "No admitted checkpoint",
      errors, attribution, componentErrors,
    };
  }));
}

type Case = ReturnType<typeof casesFor>[number];

function summarize(cases: Case[]) {
  const matched = cases.flatMap(row => row.errors ? [row.errors] : []);
  return {
    eligibleOutcomes: cases.length,
    admittedCheckpoints: matched.length,
    missingOrExcludedCheckpoints: cases.length - matched.length,
    methods: Object.fromEntries(METHODS.map(method => {
      const counts = metrics(matched.map(row => row[method]));
      return [method, { ...counts, availability: cases.length ? counts.predictions / cases.length : null }];
    })),
    pairedAgainstExperimental: Object.fromEntries(METHODS.filter(method => method !== "experimental").map(method => {
      const paired = matched.filter(row => row.experimental.signedErrorSeconds !== null && row[method].signedErrorSeconds !== null);
      const experimental = metrics(paired.map(row => row.experimental));
      const comparator = metrics(paired.map(row => row[method]));
      return [method, {
        count: paired.length, experimental, comparator,
        deltaMeanAbsoluteErrorSeconds: paired.length ? experimental.meanAbsoluteErrorSeconds! - comparator.meanAbsoluteErrorSeconds! : null,
      }];
    })),
  };
}

function excludeConflicts<T extends { integrityDigest: string }>(rows: T[], identity: (value: T) => string, reject: (id: string) => void) {
  const groups = new Map<string, Map<string, T>>();
  for (const row of rows) {
    const id = identity(row);
    if (!groups.has(id)) groups.set(id, new Map());
    groups.get(id)!.set(row.integrityDigest, row);
  }
  return [...groups].sort(([a], [b]) => compareKeys(a, b)).flatMap(([id, revisions]) => {
    if (revisions.size === 1) return [...revisions.values()];
    reject(id);
    return [];
  });
}

export function evaluateStudy(value: unknown, custodyCatalog?: unknown) {
  const request = record(value, "study");
  requireVersion(request.protocol, PROTOCOL, "Study protocol");
  const subject = key(request.subject, "study.subject");
  const dataKind = choice(request.dataKind, ["synthetic", "real"], "study.dataKind");
  const captureKind = dataKind === "synthetic" ? "synthetic"
    : choice(request.captureKind, ["prospective_capture", "historical_capture"], "study.captureKind");
  const testFromDate = date(request.testFromDate, "study.testFromDate");
  const custody = readCustody(custodyCatalog);
  const exclusions: { kind: "checkpoint" | "outcome"; ref: string; reason: string }[] = [];
  const trusted = (kind: ReceiptKind, digest: string, observedAt: string, cutoff?: string) => {
    if (dataKind === "synthetic") return;
    const row = custody.get(digest);
    if (!row || row.kind !== kind) throw new TypeError("Missing independent custody or outcome review receipt");
    if (row.anchoredAt < observedAt || (cutoff && row.anchoredAt > cutoff)) {
      throw new TypeError("Independent receipt falls outside the evidence availability window");
    }
  };
  const readRows = <T,>(kind: "checkpoint" | "outcome", rows: unknown, parse: (row: unknown) => T) =>
    list(rows, `${kind}s`).flatMap((row, index) => {
      try {
        return [parse(row)];
      } catch (error) {
        exclusions.push({ kind, ref: `input[${index}]`, reason: error instanceof Error ? error.message : "Invalid artifact" });
        return [];
      }
    });
  const admittedCheckpoints = readRows("checkpoint", request.checkpoints, row => {
    const checkpoint = replayCheckpoint(row);
    if (checkpoint.target.subject !== subject || checkpoint.source.kind !== captureKind) {
      throw new TypeError("Checkpoint subject or capture kind does not match the study");
    }
    const historical = captureKind === "historical_capture";
    trusted(historical ? "historical_input" : "checkpoint",
      historical ? checkpoint.inputDigest : checkpoint.integrityDigest, checkpoint.capturedAt, checkpoint.cutoff);
    return checkpoint;
  });
  const admittedOutcomes = readRows("outcome", request.outcomes, row => {
    const outcome = readOutcome(row);
    if (outcome.target.subject !== subject || outcome.dataKind !== dataKind) {
      throw new TypeError("Outcome subject or data kind does not match the study");
    }
    if (outcome.qualificationReasons.length) throw new TypeError(outcome.qualificationReasons.join("; "));
    trusted("outcome", outcome.integrityDigest, outcome.source.knownAt!);
    return outcome;
  });
  const checkpoints = excludeConflicts(admittedCheckpoints, row => checkpointKey(row.target, row.horizon),
    ref => exclusions.push({ kind: "checkpoint", ref, reason: "Conflicting checkpoint artifacts for one target and horizon" }));
  const uniqueEvents = excludeConflicts(admittedOutcomes, row => row.target.raceId,
    ref => exclusions.push({ kind: "outcome", ref, reason: "Conflicting outcome revisions for one event" }));
  const uniqueDates = excludeConflicts(uniqueEvents, row => row.target.raceDate,
    ref => exclusions.push({ kind: "outcome", ref, reason: "Multiple outcome artifacts on the same local date" }));
  const outcomes = excludeConflicts(uniqueDates, row => row.workoutId ? `workout:${row.workoutId}` : `target:${targetKey(row.target)}`,
    ref => exclusions.push({ kind: "outcome", ref, reason: "Outcome workout is linked to multiple events" }));
  const cases = casesFor(outcomes, new Map(checkpoints.map(row => [checkpointKey(row.target, row.horizon), row])), testFromDate);
  const targetIds = new Set(outcomes.map(row => targetKey(row.target)));
  for (const checkpoint of checkpoints) {
    if (!targetIds.has(targetKey(checkpoint.target))) {
      exclusions.push({ kind: "checkpoint", ref: checkpoint.integrityDigest, reason: "No matching admitted outcome; checkpoint retained for later scoring" });
    }
  }
  const checkpointDigests = checkpoints.map(row => captureKind === "historical_capture" ? row.inputDigest : row.integrityDigest);
  const evidenceCustody = [...checkpointDigests, ...outcomes.map(row => row.integrityDigest)].flatMap(digest => {
    const receipt = dataKind === "real" ? custody.get(digest) : null;
    return receipt ? [{ digest, ...receipt }] : [];
  }).sort((a, b) => compareKeys(a.digest, b.digest));
  return {
    protocol: PROTOCOL, subject, dataKind, captureKind, testFromDate, modelVersions: MODEL_VERSIONS,
    predictionType: "current_capability_checkpoint",
    eligibleOutcomeCount: outcomes.length, largeErrorThresholdSeconds: LARGE_ERROR_SECONDS,
    summaries: SPLITS.flatMap(split => HORIZONS.map(horizon => ({
      split, horizon, ...summarize(cases.filter(row => row.split === split && row.horizon === horizon)),
    }))),
    cases, exclusions, evidenceCustody,
    limitations: [
      "Each horizon is reported separately. Multiple checkpoints for the same event share one outcome.",
      "A later race is an imperfect proxy for earlier current capability. Preparation and race conditions can change. These are not date-specific race-day forecasts.",
      "Signed error is prediction minus result in seconds. Missing artifacts and admitted model abstentions are reported separately.",
      "A digest detects alteration. Real results depend on the independently reviewed custody catalog and outcome sources.",
      "Prospective artifacts pin predictions before the cutoff. Historical replay pins only the frozen input basis and may compute predictions later.",
      "Small samples and synthetic runs describe the supplied cases only. No inferential validation or uncertainty interval is produced.",
    ],
  };
}

export type StudyReport = ReturnType<typeof evaluateStudy>;
