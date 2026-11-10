// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./prediction-source', () => ({ createValidationEvidenceReader: vi.fn(), createValidationMetadataReader: vi.fn() }));
import { createValidationEvidenceReader, createValidationMetadataReader } from './prediction-source';
import { handlePredictionValidation } from './prediction-service';
const secret = 'synthetic-authentication-secret-never-deployed';
const env = { PREDICTION_VALIDATION_ENABLED: 'true', PREDICTION_VALIDATION_START_DATE: '2026-11-10', HM_CAPTURE_ENABLED: 'true', CRON_SECRET: secret,
  HM_CAPTURE_PROJECT_ID: 'fixture', HM_CAPTURE_OWNER_UID: 'owner', HM_CAPTURE_SUBJECT: 'subject', HM_CAPTURE_RACE_ID: 'pilot',
  HM_CAPTURE_AUTHORIZATION: 'approval', HM_CAPTURE_BUCKET: 'private-bucket',
  HM_CAPTURE_WIF_AUDIENCE: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/vercel',
  HM_CAPTURE_WRITER_SA: 'writer@fixture.iam.gserviceaccount.com', HM_CAPTURE_VERIFIER_SA: 'verifier@fixture.iam.gserviceaccount.com', HM_CAPTURE_READER_SA: 'reader@fixture.iam.gserviceaccount.com' };
beforeEach(() => vi.clearAllMocks());
describe('secure scheduled validation service', () => {
  const now = () => '2026-11-15T14:00:00.000Z';
  it.each([undefined, '', 'Bearer incorrect'])('rejects unauthorized requests before storage/Firestore access', async auth => {
    const open = vi.fn(), request = vi.fn();
    const response = await handlePredictionValidation(new Request('https://example.invalid/api/capture', { headers: auth ? { authorization: auth } : {} }), { env, now, createFirestore: open, request });
    expect(response.status).toBe(401); expect(open).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(createValidationEvidenceReader).not.toHaveBeenCalled();
  });
  it('fails closed when credentials, activation date or feature enablement are absent', async () => {
    const req = new Request('https://example.invalid/api/capture', { headers: { authorization: `Bearer ${secret}` } });
    for (const extra of [{ CRON_SECRET: undefined }, { PREDICTION_VALIDATION_START_DATE: undefined }, { NEXT_PUBLIC_DISABLE_HYBRID_V11: 'true' }]) {
      const response = await handlePredictionValidation(req, { env: { ...env, ...extra }, now }); expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(secret);
    }
    expect((await handlePredictionValidation(req, { env: { ...env, PREDICTION_VALIDATION_ENABLED: undefined }, now })).status).toBe(404);
  });
  it('off-hour calls do zero new IO and never interfere with legacy retry cron times', async () => {
    const request = vi.fn(); const response = await handlePredictionValidation(new Request('https://example.invalid/api/capture', { headers: { authorization: `Bearer ${secret}` } }),
      { env, now: () => '2026-11-15T17:00:00.000Z', request });
    expect(await response.json()).toMatchObject({ status: 'idle' }); expect(request).not.toHaveBeenCalled();
  });
  it('authenticated dry-run loads evidence once, disposes the client and never writes', async () => {
    const evidence = vi.fn(async () => ({ input: { asOf: now(), workouts: [], races: [], plans: [], overrides: {}, options: {} }, discovered: [], limitations: [], usage: { documents: {}, queryMinimumReads: 4, firestoreWrites: 0 } }));
    vi.mocked(createValidationEvidenceReader).mockReturnValue(evidence as never);
    const dispose = vi.fn(async () => {}), create = vi.fn(), verifyPolicy = vi.fn();
    const response = await handlePredictionValidation(new Request('https://example.invalid/api/capture?mode=validation-dry-run', { headers: { authorization: `Bearer ${secret}` } }),
      { env, now, createFirestore: async () => ({ db: {} as never, dispose }), validationStore: { verifyPolicy, create, read: vi.fn() } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'dry_run', usage: { firestoreWrites: 0, gcsWrites: 0 } });
    expect(evidence).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1);
    expect(createValidationMetadataReader).not.toHaveBeenCalled();
  });
});
