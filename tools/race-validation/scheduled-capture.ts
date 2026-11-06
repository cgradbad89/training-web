import { createHash, timingSafeEqual } from "node:crypto";
import { checkpointSchedule, dueCheckpoints, replayCheckpoint, sealCheckpoint, type Checkpoint } from "./checkpoint";
import { HORIZONS, PROTOCOL, checkpointKey, instant, readTarget, string, type Target } from "./evidence";

export type CaptureSlot = ReturnType<typeof dueCheckpoints>[number];

export interface CaptureSource {
  capturedAt: string;
  reference: string;
  counts: { workouts: number; races: number; overrides: number };
  coverage: unknown;
  inputs: unknown;
  /** Result of checking the enrolled race record inside the same consistent read. */
  race?: "present" | "absent" | "date_mismatch";
}

export interface StoredCapture {
  generation: string;
  createdAt: string;
  artifact: unknown;
}

export interface PolicyReceipt {
  /** True only when the bucket retention policy is irreversibly locked. */
  retentionLocked: boolean;
}

export interface CaptureStore {
  verifyPolicy(): Promise<PolicyReceipt | void>;
  read(name: string): Promise<StoredCapture | null>;
  /** Must use a create-only precondition; even an identical object is a conflict. */
  create(name: string, checkpoint: Checkpoint): Promise<"created" | "exists">;
}

export interface CaptureConfig {
  enabled: boolean;
  secret: string;
  target: Target;
  authorization: string;
  codeRevision: string;
  /** Bounded in-invocation retry for transient source and storage failures. Default: none. */
  retry?: { retries: number; delaysMs: readonly number[]; budgetMs: number };
}

type CaptureOutcome = "disabled" | "unauthorized" | "rejected" | "idle" | "captured" | "abstained" | "duplicate" | "missed" | "failed";

export interface CaptureResult {
  status: CaptureOutcome;
  checkpointDate?: string;
  horizon?: CaptureSlot["horizon"];
  counts?: CaptureSource["counts"];
  /** Original object generation and server creation time of the verified receipt. Opaque, non-private. */
  generation?: string;
  createdAt?: string;
  retentionLocked?: boolean;
  attempts?: number;
  reason?: "enrollment_mismatch" | "source_failed" | "capture_too_late" | "invalid_capture" | "storage_policy" | "storage_failed" | "unverified_generation";
}

export function pilotTarget(subject: string, raceId: string): Target {
  return readTarget({ subject, raceId, raceDate: "2027-03-20", timeZone: "America/New_York" });
}

function authorized(header: string | null, secret: string): boolean {
  if (!header || typeof secret !== "string" || secret.length < 32) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}

export function captureObjectName(key: string): string {
  return `half-marathon/v1/${createHash("sha256").update(key).digest("hex")}.json`;
}

export function missedCaptureSlots(target: Target, now: string, independentlyPresentKeys: ReadonlySet<string>) {
  const at = instant(now, "audit time");
  return HORIZONS.flatMap(horizon => {
    const slot = checkpointSchedule(target, horizon);
    const key = checkpointKey(target, horizon);
    return slot.cutoff < at && !independentlyPresentKeys.has(key) ? [{ key, horizon, ...slot }] : [];
  });
}

/** Rebuild the independent custody entry from an authenticated generation read. */
export function verifyCaptureGeneration(object: StoredCapture, slot: CaptureSlot, observedAt: string, sourceReference: string) {
  if (!/^[1-9]\d*$/.test(object.generation)) throw new Error("Invalid generation");
  const createdAt = instant(object.createdAt, "object generation creation");
  const checkpoint = replayCheckpoint(object.artifact);
  if (checkpoint.key !== slot.key || checkpoint.source.kind !== "prospective_capture"
    || checkpoint.capturedAt > createdAt || createdAt > slot.cutoff || createdAt > instant(observedAt, "verification time")) {
    throw new Error("Generation does not establish a pre-cutoff checkpoint");
  }
  return { checkpoint, custody: {
    kind: "checkpoint" as const, digest: checkpoint.integrityDigest, anchoredAt: createdAt,
    reference: `${string(sourceReference, "original generation reference")}#${object.generation}`,
  } };
}

const TRANSIENT = new Set<NonNullable<CaptureResult["reason"]>>(["source_failed", "storage_failed"]);

/** Whitelisted, payload-free log line: status, horizon, date, counts, opaque generation. */
export function safeCaptureLog(result: CaptureResult): string {
  const { status, checkpointDate, horizon, counts, generation, reason, attempts, retentionLocked } = result;
  return JSON.stringify({ event: "half_marathon_capture", status, checkpointDate, horizon, counts, generation, reason, attempts, retentionLocked });
}

/** Dormant server handler. Mount only after a separate production review. */
export async function runScheduledCapture(
  authorizationHeader: string | null,
  config: CaptureConfig,
  ports: {
    now: () => string;
    readSource: (slot: CaptureSlot) => Promise<CaptureSource>;
    store: CaptureStore;
    sleep?: (ms: number) => Promise<void>;
  },
  request: { raceId?: string } = {},
): Promise<CaptureResult> {
  if (config.enabled !== true) return { status: "disabled" };
  if (!authorized(authorizationHeader, config.secret)) return { status: "unauthorized" };
  // Enrollment is server-owned: a caller can never select a different race or subject.
  if (request.raceId !== undefined && request.raceId !== config.target.raceId) {
    return { status: "rejected", reason: "enrollment_mismatch" };
  }
  const first = instant(ports.now(), "invocation time");
  if (!dueCheckpoints([config.target], first)[0]) return { status: "idle" };

  const retry = config.retry ?? { retries: 0, delaysMs: [], budgetMs: 0 };
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let result = await captureAttempt(config, ports);
  for (let attempt = 1; attempt <= retry.retries && result.reason && TRANSIENT.has(result.reason); attempt++) {
    const delay = retry.delaysMs[Math.min(attempt - 1, retry.delaysMs.length - 1)] ?? 0;
    const at = Date.parse(instant(ports.now(), "retry time"));
    const slot = dueCheckpoints([config.target], first)[0];
    // Never retry across the checkpoint cutoff or beyond the invocation budget.
    if (at - Date.parse(first) + delay > retry.budgetMs || at + delay >= Date.parse(slot.cutoff)) break;
    await sleep(delay);
    result = { ...(await captureAttempt(config, ports)), attempts: attempt + 1 };
  }
  return result;
}

async function captureAttempt(
  config: CaptureConfig,
  ports: { now: () => string; readSource: (slot: CaptureSlot) => Promise<CaptureSource>; store: CaptureStore },
): Promise<CaptureResult> {
  const start = instant(ports.now(), "invocation time");
  const slot = dueCheckpoints([config.target], start)[0];
  if (!slot) return { status: "idle" };

  const context = { checkpointDate: slot.checkpointDate, horizon: slot.horizon };
  const now = () => instant(ports.now(), "server time");
  const name = captureObjectName(slot.key);
  const failure = (reason: NonNullable<CaptureResult["reason"]>, counts?: CaptureSource["counts"]): CaptureResult => ({
    ...context, status: reason === "capture_too_late" ? "missed" : "failed", reason, ...(counts ? { counts } : {}),
  });
  let policy: PolicyReceipt | void;
  try {
    policy = await ports.store.verifyPolicy();
  } catch {
    return failure("storage_policy");
  }
  const custody = policy ? { retentionLocked: policy.retentionLocked } : {};
  const receipt = (object: StoredCapture) => ({ generation: object.generation, createdAt: object.createdAt, ...custody });
  let existing: StoredCapture | null;
  try {
    existing = await ports.store.read(name);
  } catch {
    return failure("storage_failed");
  }
  if (existing) {
    try {
      verifyCaptureGeneration(existing, slot, now(), name);
      return { ...context, status: "duplicate", ...receipt(existing) };
    } catch {
      return failure("unverified_generation");
    }
  }
  if (now() > slot.cutoff) return failure("capture_too_late");

  let source: CaptureSource;
  try {
    source = await ports.readSource(slot);
  } catch {
    return failure("source_failed");
  }
  if (!source || typeof source !== "object") return failure("source_failed");
  if (source.race === "date_mismatch") return failure("enrollment_mismatch", source.counts);
  let checkpoint: Checkpoint;
  try {
    const readAt = instant(source.capturedAt, "source capture time");
    const afterRead = now();
    if (afterRead > slot.cutoff || readAt > slot.cutoff) return failure("capture_too_late", source.counts);
    if (readAt < start || readAt > afterRead) return failure("invalid_capture", source.counts);
    checkpoint = sealCheckpoint({
      protocol: PROTOCOL, target: slot.target, horizon: slot.horizon, capturedAt: readAt,
      source: {
        kind: "prospective_capture", reference: source.reference,
        authorization: string(config.authorization, "approved capture authorization"), codeRevision: config.codeRevision,
      },
      coverage: source.coverage, inputs: source.inputs,
    });
  } catch {
    return failure("invalid_capture", source.counts);
  }
  if (now() > slot.cutoff) return failure("capture_too_late", source.counts);

  let disposition: "created" | "exists";
  let stored: StoredCapture | null;
  try {
    disposition = await ports.store.create(name, checkpoint);
  } catch {
    // A lost response or a concurrent winner can surface as an error. Only a verified original
    // generation already in storage converts it to a duplicate; otherwise the failure stands.
    try {
      if (!(await ports.store.read(name))) return failure("storage_failed", source.counts);
      disposition = "exists";
    } catch {
      return failure("storage_failed", source.counts);
    }
  }
  try {
    stored = await ports.store.read(name);
  } catch {
    return failure("storage_failed", source.counts);
  }
  try {
    if (!stored) throw new Error("Missing original generation");
    const { checkpoint: verified } = verifyCaptureGeneration(stored, slot, now(), name);
    if (disposition === "created" && verified.integrityDigest !== checkpoint.integrityDigest) {
      throw new Error("Stored artifact differs from sealed capture");
    }
    return { ...context, counts: source.counts, ...receipt(stored),
      status: disposition === "exists" ? "duplicate"
        : verified.results.predictions.experimental.seconds === null ? "abstained" : "captured" };
  } catch {
    return failure("unverified_generation", source.counts);
  }
}
