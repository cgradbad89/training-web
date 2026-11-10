import { createHash, timingSafeEqual } from "node:crypto";
import { Firestore as GoogleFirestore } from "@google-cloud/firestore";
import { ExternalAccountClient, GoogleAuth } from "google-auth-library";
import type { Firestore } from "firebase-admin/firestore";
import { CAPTURE_SCOPES, createImpersonatedCredential } from "./capture-credentials";
import { createFirestoreCaptureReader, createFirestoreProbe, createRaceMetadataReader } from "./capture-source";
import { DEFAULT_ENROLLMENT_TIME_ZONE, enrollmentReference, isHalfMarathon, resolveEnrollments, type EnrollmentPlan, type RaceMeta } from "./enrollment";
import { createPrivateCaptureStore, type RetentionMode } from "./capture-storage";
import { key, string } from "./evidence";
import { pilotTarget, runScheduledCapture, safeCaptureLog, type CaptureConfig, type CaptureResult, type CaptureSource, type CaptureStore } from "./scheduled-capture";

/** Everything is server-only configuration. Nothing here is a NEXT_PUBLIC_ variable. */
export const CAPTURE_ENV = [
  "HM_CAPTURE_ENABLED", "CRON_SECRET", "HM_CAPTURE_PROJECT_ID", "HM_CAPTURE_OWNER_UID", "HM_CAPTURE_SUBJECT", "HM_CAPTURE_RACE_ID",
  "HM_CAPTURE_AUTHORIZATION", "HM_CAPTURE_BUCKET", "HM_CAPTURE_RETENTION_MODE", "HM_CAPTURE_MIN_RETENTION_DAYS",
  "HM_CAPTURE_WIF_AUDIENCE", "HM_CAPTURE_WRITER_SA", "HM_CAPTURE_VERIFIER_SA", "HM_CAPTURE_READER_SA",
] as const;

/** Optional server-only settings. Unset keeps the pinned single-race behavior with zero discovery reads. */
export const CAPTURE_OPTIONAL_ENV = ["HM_CAPTURE_AUTO_ENROLL", "HM_CAPTURE_TIME_ZONE"] as const;

export type CaptureEnv = Partial<Record<string, string | undefined>>;

export interface CaptureSettings {
  config: CaptureConfig;
  projectId: string;
  ownerUid: string;
  bucket: string;
  retentionMode: RetentionMode;
  minimumRetentionSeconds: number;
  audience: string;
  writerEmail: string;
  verifierEmail: string;
  readerEmail: string;
  /** Phase 3H gate: exactly "true" adds bounded discovery of the saved active half marathon. Default off. */
  autoEnroll: boolean;
  /** Time zone for automatically enrolled races (races carry no zone of their own). */
  timeZone: string;
}

/**
 * Returns null unless capture is explicitly enabled. An enabled but invalid configuration throws a
 * message naming only the variable, never its value.
 */
export function readCaptureSettings(env: CaptureEnv): CaptureSettings | null {
  if (env.HM_CAPTURE_ENABLED !== "true") return null;
  const need = (name: (typeof CAPTURE_ENV)[number]) => string(env[name], name);
  const secret = need("CRON_SECRET");
  if (secret.length < 32) throw new TypeError("CRON_SECRET must be at least 32 characters");
  const mode = env.HM_CAPTURE_RETENTION_MODE ?? "locked";
  if (mode !== "locked" && mode !== "unlocked_pilot") throw new TypeError("HM_CAPTURE_RETENTION_MODE is invalid");
  const days = Number(env.HM_CAPTURE_MIN_RETENTION_DAYS ?? 365);
  if (!Number.isInteger(days) || days < 120) throw new TypeError("HM_CAPTURE_MIN_RETENTION_DAYS must be an integer of at least 120");
  const [writerEmail, verifierEmail, readerEmail] = [need("HM_CAPTURE_WRITER_SA"), need("HM_CAPTURE_VERIFIER_SA"), need("HM_CAPTURE_READER_SA")];
  if (new Set([writerEmail, verifierEmail, readerEmail]).size !== 3) throw new TypeError("Writer, verifier and reader identities must be distinct");
  const ownerUid = key(need("HM_CAPTURE_OWNER_UID"), "HM_CAPTURE_OWNER_UID");
  if (ownerUid.includes("/")) throw new TypeError("HM_CAPTURE_OWNER_UID is invalid");
  const timeZone = env.HM_CAPTURE_TIME_ZONE ?? DEFAULT_ENROLLMENT_TIME_ZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { throw new TypeError("HM_CAPTURE_TIME_ZONE is invalid"); }
  return {
    autoEnroll: env.HM_CAPTURE_AUTO_ENROLL === "true", timeZone,
    config: {
      enabled: true, secret, target: pilotTarget(need("HM_CAPTURE_SUBJECT"), need("HM_CAPTURE_RACE_ID")),
      authorization: need("HM_CAPTURE_AUTHORIZATION"), codeRevision: env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
      retry: { retries: 2, delaysMs: [5_000, 20_000], budgetMs: 120_000 },
    },
    projectId: need("HM_CAPTURE_PROJECT_ID"), ownerUid, bucket: need("HM_CAPTURE_BUCKET"), retentionMode: mode,
    minimumRetentionSeconds: days * 86_400, audience: need("HM_CAPTURE_WIF_AUDIENCE"), writerEmail, verifierEmail, readerEmail,
  };
}

export interface CaptureDeps {
  env: CaptureEnv;
  now?: () => string;
  request?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Supplies the platform OIDC token; defaults to the Vercel request header. */
  oidcToken?: (request: Request) => Promise<string>;
  /** Test seam. Production builds a keyless Firestore client authorized only by the reader identity. */
  createFirestore?: (settings: CaptureSettings, request: Request, oidcToken: () => Promise<string>) => Promise<{ db: Firestore; dispose: () => Promise<void>; diagnose?: () => Promise<Record<string, unknown>> }>;
}

type HeaderSource = { getRequestHeaders(url?: string): Promise<unknown> };

/**
 * google-auth-library 10 returns request headers as a Fetch `Headers` object, but the gRPC stack beneath
 * Firestore enumerates plain-object keys, so the bearer token was silently dropped and Firestore answered as
 * if unauthenticated. Return a plain object instead; every other member is passed through unchanged.
 */
export function withPlainRequestHeaders<T extends HeaderSource>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === "getRequestHeaders") {
        return async (url?: string) => {
          const headers = await target.getRequestHeaders(url);
          return headers && typeof (headers as Headers).entries === "function" ? Object.fromEntries((headers as Headers).entries()) : headers;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

class PlainHeaderAuth extends GoogleAuth {
  override async getClient(): Promise<never> {
    return withPlainRequestHeaders(await super.getClient() as unknown as HeaderSource) as never;
  }
}

/**
 * firebase-admin's Firestore wrapper accepts only key or default credentials, so the keyless path uses the
 * underlying client with a workload-identity auth client that impersonates the reader service account.
 */
export async function defaultFirestore(settings: CaptureSettings, _request: Request, oidcToken: () => Promise<string>) {
  const authClient = ExternalAccountClient.fromJSON({
    type: "external_account", audience: settings.audience, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(settings.readerEmail)}:generateAccessToken`,
    subject_token_supplier: { getSubjectToken: oidcToken },
  });
  if (!authClient) throw new Error("Keyless Firestore credential unavailable");
  const auth = new PlainHeaderAuth({ authClient, projectId: settings.projectId });
  const db = new GoogleFirestore({ projectId: settings.projectId, auth } as ConstructorParameters<typeof GoogleFirestore>[0]);
  // Preflight-only: which identity and scopes the issued token carries. Reports no token or payload.
  const diagnose = async () => {
    const { token } = await authClient.getAccessToken();
    const info = (await (await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token ?? "")}`,
      { signal: AbortSignal.timeout(10_000) })).json()) as { email?: string; scope?: string };
    // Ask Google which of these project permissions the issued token actually holds. Names only, no data.
    const asked = ["datastore.entities.get", "datastore.entities.list", "datastore.databases.getMetadata", "datastore.entities.create", "datastore.entities.delete"];
    let granted: string[] | null = null;
    try {
      const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(settings.projectId)}:testIamPermissions`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: asked }), signal: AbortSignal.timeout(10_000) });
      const body = (await response.json()) as { permissions?: unknown };
      granted = response.ok && Array.isArray(body.permissions) ? body.permissions.filter((name): name is string => asked.includes(name as string)) : null;
    } catch { granted = null; }
    // The same one-document, name-only read over REST returns structured error details that gRPC hides.
    let rest: Record<string, unknown> | null = null;
    try {
      const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(settings.projectId)}/databases/(default)/documents/users/${encodeURIComponent(settings.ownerUid)}:runQuery`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "healthWorkouts" }], select: { fields: [{ fieldPath: "__name__" }] }, limit: 1 } }) });
      const body = (await response.json().catch(() => null)) as unknown;
      const first = Array.isArray(body) ? body[0] : body;
      const error = (first as { error?: { status?: unknown; message?: unknown; details?: unknown } } | null)?.error;
      const info = Array.isArray(error?.details) ? (error.details as { reason?: unknown; metadata?: Record<string, unknown> }[]).find(detail => detail?.reason) : undefined;
      const clean = (value: unknown) => typeof value === "string" ? value.split(settings.ownerUid).join("<uid>").slice(0, 160) : undefined;
      rest = { http: response.status, status: clean(error?.status), reason: clean(info?.reason), permission: clean(info?.metadata?.permission),
        resource: clean(info?.metadata?.resource), message: clean(error?.message) };
    } catch { rest = null; }
    return { tokenPrincipal: info.email, cloudPlatformScope: (info.scope ?? "").includes("auth/cloud-platform"), grantedPermissions: granted, rest };
  };
  return { db: db as unknown as Firestore, dispose: () => db.terminate(), diagnose };
}

type PinnedState = "present" | "absent" | "date_mismatch" | "not_half_marathon" | "unavailable";

/**
 * Preflight-only. Compares the server-armed enrollment with the stored race and summarizes discovery, without
 * returning any race id, owner id, date or name. A definite mismatch fails preflight; a failed lookup is
 * reported as "unavailable" and does not change the existing verdict.
 */
async function describeEnrollment(db: Firestore, settings: CaptureSettings) {
  const out: { pinned: PinnedState; autoEnabled: boolean; discovery?: { candidates: number; eligible: number; notes: string[] } } =
    { pinned: "unavailable", autoEnabled: settings.autoEnroll };
  try {
    const reader = createRaceMetadataReader(db, settings.ownerUid, { projectId: settings.projectId });
    const stored = await reader.byId(settings.config.target.raceId);
    out.pinned = !stored ? "absent" : stored.raceDate !== settings.config.target.raceDate ? "date_mismatch"
      : !isHalfMarathon(stored) ? "not_half_marathon" : "present";
    if (settings.autoEnroll) {
      const found = await reader.active();
      const plan = resolveEnrollments({ pinned: settings.config.target, subject: settings.config.target.subject, timeZone: settings.timeZone,
        now: new Date().toISOString(), autoEnabled: true, discovered: found.races, overflow: found.overflow });
      out.discovery = { candidates: plan.counts.candidates, eligible: plan.counts.eligible, notes: plan.notes };
    }
  } catch { /* reported as unavailable */ }
  return out;
}

const SEVERITY: CaptureResult["status"][] = ["failed", "missed", "captured", "abstained", "duplicate", "rejected", "idle", "unauthorized", "disabled"];

export function bearerMatches(header: string | null, secret: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return !!header && timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}

const STATUS: Record<CaptureResult["status"], number> = {
  disabled: 404, unauthorized: 401, rejected: 400, idle: 200, captured: 200, abstained: 200, duplicate: 200, missed: 500, failed: 500,
};

function respond(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Pure Request → Response collector. A future route file only re-exports `GET` around this function.
 * `?mode=preflight` authenticates, proves token exchange, bucket policy, least-privilege identities and
 * a one-document Firestore read, and creates no object.
 */
export async function handleCaptureRequest(request: Request, deps: CaptureDeps): Promise<Response> {
  let settings: CaptureSettings | null;
  try {
    settings = readCaptureSettings(deps.env);
  } catch {
    return respond({ status: "failed", reason: "invalid_configuration" }, 500);
  }
  if (!settings) return respond({ status: "disabled" }, STATUS.disabled);
  if (!bearerMatches(request.headers.get("authorization"), settings.config.secret)) return respond({ status: "unauthorized" }, STATUS.unauthorized);

  const url = new URL(request.url);
  const fetcher = deps.request ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const oidc = () => (deps.oidcToken ? deps.oidcToken(request) : Promise.resolve(request.headers.get("x-vercel-oidc-token") ?? ""));
  const credential = (email: string, scopes: readonly string[]) => createImpersonatedCredential({
    audience: settings.audience, serviceAccountEmail: email, projectId: settings.projectId, scopes, oidcToken: oidc, request: fetcher });
  let store: CaptureStore;
  try {
    store = createPrivateCaptureStore({
      bucket: settings.bucket, minimumRetentionSeconds: settings.minimumRetentionSeconds, retentionMode: settings.retentionMode, request: fetcher,
      writer: credential(settings.writerEmail, CAPTURE_SCOPES.storage), verifier: credential(settings.verifierEmail, CAPTURE_SCOPES.storageReadOnly),
    });
  } catch {
    return respond({ status: "failed", reason: "invalid_configuration" }, 500);
  }
  const open = deps.createFirestore ?? defaultFirestore;

  if (url.searchParams.get("mode") === "preflight") {
    const checks: { policy: boolean; identities: boolean; firestore: boolean; firestoreStage?: "open" | "bind" | "read"; firestoreCode?: number; firestoreReason?: string; credential?: Record<string, unknown>; enrollment?: Awaited<ReturnType<typeof describeEnrollment>> } =
      { policy: false, identities: false, firestore: false };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await store.verifyPolicy();
      checks.policy = checks.identities = true;
    } catch { /* checks already carry the safe outcome */ }
    try {
      checks.firestoreStage = "open";
      handle = await open(settings, request, oidc);
      checks.firestoreStage = "bind";
      const probe = createFirestoreProbe(handle.db, settings.ownerUid, { projectId: settings.projectId });
      checks.firestoreStage = "read";
      await probe();
      checks.firestore = true;
      delete checks.firestoreStage;
      checks.enrollment = await describeEnrollment(handle.db, settings);
    } catch (error) {
      // A numeric gRPC status and the failing stage identify the problem without any payload or message text.
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "number") checks.firestoreCode = code;
      // Coarse category from Google's own error text; the text itself is never returned.
      const text = String((error as { message?: unknown })?.message ?? "");
      checks.firestoreReason = /insufficient authentication scopes/i.test(text) ? "scope"
        : /has not been used|is disabled|SERVICE_DISABLED/i.test(text) ? "api_disabled"
        : /user project|quota project|serviceusage/i.test(text) ? "consumer_project"
        : /missing or insufficient permissions|permission .* denied|IAM_PERMISSION_DENIED/i.test(text) ? "iam"
        : /could not load the default credentials/i.test(text) ? "no_credential" : "other";
      if (handle?.diagnose) checks.credential = await handle.diagnose().catch(() => ({ unavailable: true }));
    } finally {
      await handle?.dispose().catch(() => undefined);
    }
    const mismatch = checks.enrollment?.pinned === "absent" || checks.enrollment?.pinned === "date_mismatch" || checks.enrollment?.pinned === "not_half_marathon";
    const ok = checks.policy && checks.firestore && !mismatch;
    return respond({ status: ok ? "preflight_ok" : "preflight_failed", checks }, ok ? 200 : 500);
  }

  // The scheduler may call readSource once per attempt. Every attempt opens its own Firestore client and
  // disposes it as soon as the read has produced plain data, so a retry can never leak its predecessor's
  // gRPC channel and auth client (only the last handle used to be terminated).
  const readSource = async (slot: Parameters<ReturnType<typeof createFirestoreCaptureReader>>[0]): Promise<CaptureSource> => {
    const handle = await open(settings, request, oidc);
    try {
      return await createFirestoreCaptureReader(handle.db, settings.ownerUid, { projectId: settings.projectId })(slot);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  };
  if (settings.autoEnroll) {
    return runEnrolledCaptures({ request, settings, open, oidc, now, store, readSource, sleep: deps.sleep, requestedRace: url.searchParams.get("race") });
  }
  let result: CaptureResult;
  try {
    result = await runScheduledCapture(request.headers.get("authorization"), settings.config,
      { now, readSource, store, sleep: deps.sleep }, { raceId: url.searchParams.get("race") ?? undefined });
  } catch {
    result = { status: "failed", reason: "invalid_capture" };
  }
  console.info(safeCaptureLog(result));
  const { status, checkpointDate, horizon, counts, generation, createdAt, reason, attempts, retentionLocked } = result;
  return respond({ status, checkpointDate, horizon, counts, generation, createdAt, reason, attempts, retentionLocked }, STATUS[status]);
}

/**
 * Phase 3H path, reached only when HM_CAPTURE_AUTO_ENROLL is exactly "true" (after authentication). One bounded
 * race-metadata read discovers the saved active half marathon; the pinned enrollment is always kept. A failed or
 * conflicting discovery enrolls nothing new and never cancels the pinned race. Each tracked race runs through the
 * unchanged scheduler, so checkpoints, keys, retries, cutoffs and storage behavior are identical to the pinned path.
 */
async function runEnrolledCaptures(ctx: {
  request: Request; settings: CaptureSettings; open: NonNullable<CaptureDeps["createFirestore"]>; oidc: () => Promise<string>;
  now: () => string; store: CaptureStore; sleep?: (ms: number) => Promise<void>;
  readSource: (slot: Parameters<ReturnType<typeof createFirestoreCaptureReader>>[0]) => Promise<CaptureSource>;
  requestedRace: string | null;
}): Promise<Response> {
  const { settings } = ctx;
  let discovered: RaceMeta[] | null = null;
  let overflow = false;
  let handle: Awaited<ReturnType<typeof ctx.open>> | undefined;
  try {
    handle = await ctx.open(settings, ctx.request, ctx.oidc);
    const found = await createRaceMetadataReader(handle.db, settings.ownerUid, { projectId: settings.projectId }).active();
    discovered = found.races;
    overflow = found.overflow;
  } catch {
    discovered = null; // fail safe: keep the pinned enrollment, enroll nothing new
  } finally {
    await handle?.dispose().catch(() => undefined);
  }
  const plan: EnrollmentPlan = resolveEnrollments({
    pinned: settings.config.target, subject: settings.config.target.subject, timeZone: settings.timeZone,
    now: ctx.now(), autoEnabled: true, discovered, overflow,
  });
  // A caller can only narrow to a race the server already tracks; it can never introduce one.
  if (ctx.requestedRace !== null && !plan.targets.some(target => target.raceId === ctx.requestedRace)) {
    return respond({ status: "rejected", reason: "enrollment_mismatch" }, STATUS.rejected);
  }
  const results: { ref: string; result: CaptureResult }[] = [];
  for (const target of plan.targets) {
    if (ctx.requestedRace !== null && target.raceId !== ctx.requestedRace) continue;
    let result: CaptureResult;
    try {
      result = await runScheduledCapture(ctx.request.headers.get("authorization"), { ...settings.config, target },
        { now: ctx.now, readSource: ctx.readSource, store: ctx.store, sleep: ctx.sleep }, { raceId: target.raceId });
    } catch {
      result = { status: "failed", reason: "invalid_capture" };
    }
    results.push({ ref: enrollmentReference(target), result });
    console.info(JSON.stringify({ ...JSON.parse(safeCaptureLog(result)), enrollment: enrollmentReference(target) }));
  }
  console.info(JSON.stringify({ event: "half_marathon_enrollment", tracked: plan.targets.length, notes: plan.notes, counts: plan.counts }));
  const primary = [...results].sort((a, b) => SEVERITY.indexOf(a.result.status) - SEVERITY.indexOf(b.result.status))[0]?.result ?? { status: "idle" as const };
  const { status, checkpointDate, horizon, counts, generation, createdAt, reason, attempts, retentionLocked } = primary;
  return respond({
    status, checkpointDate, horizon, counts, generation, createdAt, reason, attempts, retentionLocked,
    tracked: plan.targets.length, notes: plan.notes,
    enrollments: results.filter(entry => entry.result.status !== "idle").map(({ ref, result }) => ({
      ref, status: result.status, checkpointDate: result.checkpointDate, horizon: result.horizon, reason: result.reason, generation: result.generation })),
  }, STATUS[primary.status]);
}
