import { performance } from 'node:perf_hooks';
import { createImpersonatedCredential, CAPTURE_SCOPES } from './capture-credentials';
import { createPrivateCaptureStore } from './capture-storage';
import { bearerMatches, defaultFirestore, readCaptureSettings, type CaptureDeps } from './capture-service';
import { createValidationEvidenceReader, createValidationMetadataReader } from './prediction-source';
import { runPredictionCapture, type ValidationStore } from './prediction-capture';
import { calculateValidation, evaluationVersion, type ValidationFlags } from './prediction-models';
import { readPredictionReport } from './prediction-report';
import { inCaptureWindow, reportingDate } from './prediction-schedule';
import { isPerformanceDate, shiftPerformanceDate } from '@/utils/performanceEvidence';

const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function validationFlags(env: CaptureDeps['env']): ValidationFlags {
  return { assumeConfirmedRacesMaximal: env.NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION !== 'true',
    strictMaximalOnly: env.NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE === 'true',
    physiology: env.NEXT_PUBLIC_DISABLE_PHYSIOLOGY_HYDRATION !== 'true',
    hrEnhanced: env.NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE !== 'true',
    forecast: env.NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST !== 'true' };
}

/** Reuses the collector's authorization and keyless identities; no browser, Admin key or Firestore writes. */
export async function handlePredictionValidation(request: Request, deps: CaptureDeps & { validationStore?: ValidationStore }): Promise<Response> {
  if (deps.env.PREDICTION_VALIDATION_ENABLED !== 'true') return reply({ status: 'disabled' }, 404);
  let settings: ReturnType<typeof readCaptureSettings>;
  try { settings = readCaptureSettings(deps.env); } catch { return reply({ status: 'failed', reason: 'invalid_configuration' }, 500); }
  if (!settings) return reply({ status: 'disabled' }, 404);
  if (!bearerMatches(request.headers.get('authorization'), settings.config.secret)) return reply({ status: 'unauthorized' }, 401);
  const now = deps.now ?? (() => new Date().toISOString()), at = now(), url = new URL(request.url);
  const mode = url.searchParams.get('mode') ?? 'capture';
  if (!['capture', 'validation-dry-run', 'validation-report', 'validation-preflight'].includes(mode)) return reply({ status: 'rejected' }, 400);
  const startDate = deps.env.PREDICTION_VALIDATION_START_DATE;
  if (!startDate || !isPerformanceDate(startDate) || deps.env.NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE === 'true'
    || deps.env.NEXT_PUBLIC_DISABLE_HYBRID_V11 === 'true') return reply({ status: 'failed', reason: 'invalid_validation_configuration' }, 500);
  // Off-hour invocations (including legacy retry crons) do zero new IO.
  if (mode === 'capture' && !inCaptureWindow(at)) return reply({ status: 'idle' });
  const fetcher = deps.request ?? fetch;
  const oidc = () => deps.oidcToken ? deps.oidcToken(request) : Promise.resolve(request.headers.get('x-vercel-oidc-token') ?? '');
  const credential = (email: string, scopes: readonly string[]) => createImpersonatedCredential({ audience: settings!.audience,
    serviceAccountEmail: email, projectId: settings!.projectId, scopes, oidcToken: oidc, request: fetcher });
  const store = deps.validationStore ?? createPrivateCaptureStore<unknown>({ namespace: 'prediction-validation', bucket: settings.bucket,
    minimumRetentionSeconds: settings.minimumRetentionSeconds, retentionMode: settings.retentionMode, request: fetcher,
    writer: credential(settings.writerEmail, CAPTURE_SCOPES.storage), verifier: credential(settings.verifierEmail, CAPTURE_SCOPES.storageReadOnly) });
  const flags = validationFlags(deps.env), version = evaluationVersion(flags);
  let handle: Awaited<ReturnType<NonNullable<CaptureDeps['createFirestore']>>> | undefined;
  const open = async () => handle ??= await (deps.createFirestore ?? defaultFirestore)(settings!, request, oidc);
  try {
    if (mode === 'validation-report') {
      const to = url.searchParams.get('to') ?? reportingDate(at);
      const from = url.searchParams.get('from') ?? [startDate, shiftPerformanceDate(to, -27)].sort().at(-1)!;
      if (from < startDate) return reply({ status: 'rejected', reason: 'before_activation' }, 400);
      const requestedVersion = url.searchParams.get('version') ?? version;
      if (!/^[a-f0-9]{64}$/.test(requestedVersion)) return reply({ status: 'rejected' }, 400);
      return reply(await readPredictionReport(store, requestedVersion, from, to, at));
    }
    const metadata = async () => createValidationMetadataReader((await open()).db, settings!.ownerUid, settings!.projectId)();
    const evidence = async (at: string, hydrate: boolean) => createValidationEvidenceReader((await open()).db, settings!.ownerUid, settings!.projectId)(at, hydrate);
    if (mode === 'validation-preflight') {
      await store.verifyPolicy(); const found = await metadata();
      return reply({ status: 'validation_preflight_ok', evaluationVersion: version, activeRaces: found.races.length,
        documentsRead: found.documentsRead, firestoreWrites: 0, gcsWrites: 0 });
    }
    if (mode === 'validation-dry-run') {
      await store.verifyPolicy(); const started = performance.now(), cpu = process.cpuUsage();
      const source = await evidence(now(), flags.physiology);
      const predictions = calculateValidation(source.input, source.discovered, flags);
      const elapsed = process.cpuUsage(cpu);
      return reply({ status: source.limitations.length ? 'dry_run_incomplete' : 'dry_run', evaluatedAt: source.input.asOf,
        evaluationVersion: version, applicationRevision: settings.config.codeRevision, predictions, limitations: source.limitations,
        usage: { ...source.usage, functionDurationMs: performance.now() - started, processCpuMs: (elapsed.user + elapsed.system) / 1000,
          predictedPayloadBytes: Buffer.byteLength(JSON.stringify(predictions)), gcsWrites: 0 } });
    }
    const result = await runPredictionCapture({ codeRevision: settings.config.codeRevision, flags, startDate }, { now, store, metadata, evidence });
    console.info(JSON.stringify({ event: 'prediction_validation', status: result.status, usage: result.usage, reason: result.reason }));
    return reply(result, ['failed', 'missed'].includes(result.status) ? 500 : 200);
  } catch {
    console.error(JSON.stringify({ event: 'prediction_validation', status: 'failed', reason: 'validation_operation_failed' }));
    return reply({ status: 'failed', reason: 'validation_operation_failed' }, 500);
  } finally { await handle?.dispose().catch(() => undefined); }
}
