// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../../../../tools/race-validation/capture-service', () => ({ handleCaptureRequest: vi.fn() }))
vi.mock('../../../../../tools/race-validation/prediction-service', () => ({ handlePredictionValidation: vi.fn() }))
import { handleCaptureRequest } from '../../../../../tools/race-validation/capture-service'
import { handlePredictionValidation } from '../../../../../tools/race-validation/prediction-service'
import { GET } from '../route'
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(handleCaptureRequest).mockImplementation(async () => Response.json({ status: 'idle' }))
  vi.mocked(handlePredictionValidation).mockImplementation(async () => Response.json({ status: 'complete' }))
})
afterEach(() => vi.unstubAllEnvs())
it('leaves the legacy response intact when validation is disabled', async () => {
  vi.stubEnv('PREDICTION_VALIDATION_ENABLED', '')
  expect(await (await GET(new Request('https://example.invalid/api/capture'))).json()).toEqual({ status: 'idle' })
  expect(handlePredictionValidation).not.toHaveBeenCalled()
})
it('preserves both collectors on a shared scheduled invocation', async () => {
  vi.stubEnv('PREDICTION_VALIDATION_ENABLED', 'true')
  expect(await (await GET(new Request('https://example.invalid/api/capture'))).json()).toEqual({ checkpoint: { status: 'idle' }, validation: { status: 'complete' } })
  expect(handleCaptureRequest).toHaveBeenCalledTimes(1); expect(handlePredictionValidation).toHaveBeenCalledTimes(1)
})
it('a failed legacy capture does not prevent independent weekly capture', async () => {
  vi.stubEnv('PREDICTION_VALIDATION_ENABLED', 'true')
  vi.mocked(handleCaptureRequest).mockResolvedValue(Response.json({ status: 'failed' }, { status: 500 }))
  expect((await GET(new Request('https://example.invalid/api/capture'))).status).toBe(500)
  expect(handlePredictionValidation).toHaveBeenCalledTimes(1)
})
it('legacy preflight never writes or invokes the new collector', async () => {
  vi.stubEnv('PREDICTION_VALIDATION_ENABLED', 'true')
  await GET(new Request('https://example.invalid/api/capture?mode=preflight'))
  expect(handlePredictionValidation).not.toHaveBeenCalled()
})
it('validation read-only modes never call the legacy capture path', async () => {
  await GET(new Request('https://example.invalid/api/capture?mode=validation-dry-run'))
  expect(handleCaptureRequest).not.toHaveBeenCalled(); expect(handlePredictionValidation).toHaveBeenCalledTimes(1)
})
