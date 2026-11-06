import { createHash, timingSafeEqual } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { CAPTURE_SCOPES, createImpersonatedCredential } from "./capture-credentials";
import { createFirestoreCaptureReader, createFirestoreProbe } from "./capture-source";
import { createPrivateCaptureStore, type RetentionMode } from "./capture-storage";
import { key, string } from "./evidence";
import { pilotTarget, runScheduledCapture, safeCaptureLog, type CaptureConfig, type CaptureResult, type CaptureSource, type CaptureStore } from "./scheduled-capture";

/** Everything is server-only configuration. Nothing here is a NEXT_PUBLIC_ variable. */
export const CAPTURE_ENV = [
  "HM_CAPTURE_ENABLED", "CRON_SECRET", "HM_CAPTURE_PROJECT_ID", "HM_CAPTURE_OWNER_UID", "HM_CAPTURE_SUBJECT", "HM_CAPTURE_RACE_ID",
  "HM_CAPTURE_AUTHORIZATION", "HM_CAPTURE_BUCKET", "HM_CAPTURE_RETENTION_MODE", "HM_CAPTURE_MIN_RETENTION_DAYS",
  "HM_CAPTURE_WIF_AUDIENCE", "HM_CAPTURE_WRITER_SA", "HM_CAPTURE_VERIFIER_SA", "HM_CAPTURE_READER_SA",
] as const;

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
  return {
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
  /** Test seam; production uses a Firestore client authorized only by the reader identity. */
  createFirestore?: (settings: CaptureSettings, accessToken: () => Promise<string>) => Promise<{ db: Firestore; dispose: () => Promise<void> }>;
}

async function defaultFirestore(settings: CaptureSettings, accessToken: () => Promise<string>) {
  const app = initializeApp({
    projectId: settings.projectId,
    credential: { getAccessToken: async () => ({ access_token: await accessToken(), expires_in: 600 }) },
  }, `half-marathon-capture-${Date.now()}`);
  return { db: getFirestore(app), dispose: () => deleteApp(app) };
}

function bearerMatches(header: string | null, secret: string) {
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
  const reader = credential(settings.readerEmail, CAPTURE_SCOPES.firestoreReader);
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
    const checks = { policy: false, identities: false, firestore: false };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await store.verifyPolicy();
      checks.policy = checks.identities = true;
      handle = await open(settings, () => reader.accessToken());
      await createFirestoreProbe(handle.db, settings.ownerUid, { projectId: settings.projectId })();
      checks.firestore = true;
    } catch { /* checks already carry the safe outcome */ } finally {
      await handle?.dispose().catch(() => undefined);
    }
    const ok = checks.policy && checks.firestore;
    return respond({ status: ok ? "preflight_ok" : "preflight_failed", checks }, ok ? 200 : 500);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const readSource = async (slot: Parameters<ReturnType<typeof createFirestoreCaptureReader>>[0]): Promise<CaptureSource> => {
    handle = await open(settings, () => reader.accessToken());
    return createFirestoreCaptureReader(handle.db, settings.ownerUid, { projectId: settings.projectId })(slot);
  };
  let result: CaptureResult;
  try {
    result = await runScheduledCapture(request.headers.get("authorization"), settings.config,
      { now, readSource, store, sleep: deps.sleep }, { raceId: url.searchParams.get("race") ?? undefined });
  } catch {
    result = { status: "failed", reason: "invalid_capture" };
  } finally {
    await handle?.dispose().catch(() => undefined);
  }
  console.info(safeCaptureLog(result));
  const { status, checkpointDate, horizon, counts, generation, createdAt, reason, attempts, retentionLocked } = result;
  return respond({ status, checkpointDate, horizon, counts, generation, createdAt, reason, attempts, retentionLocked }, STATUS[status]);
}
