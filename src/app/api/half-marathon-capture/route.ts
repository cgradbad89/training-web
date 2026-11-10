import { handleCaptureRequest } from '../../../../tools/race-validation/capture-service'
import { handlePredictionValidation } from '../../../../tools/race-validation/prediction-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Both collectors share this route. Each has bounded retries; Hobby Fluid Compute permits up to 300 seconds.
export const maxDuration = 300

export async function GET(request: Request) {
  const mode = new URL(request.url).searchParams.get('mode')
  if (mode?.startsWith('validation-')) return handlePredictionValidation(request, { env: process.env })
  // Existing checkpoint capture and preflight keep their own protocol, gating and responses.
  const legacy = await handleCaptureRequest(request, { env: process.env })
  if (mode || process.env.PREDICTION_VALIDATION_ENABLED !== 'true') return legacy
  const validation = await handlePredictionValidation(request, { env: process.env })
  return Response.json({ checkpoint: await legacy.json(), validation: await validation.json() }, {
    status: !legacy.ok ? legacy.status : validation.ok ? legacy.status : validation.status, headers: { 'Cache-Control': 'no-store' },
  })
}
