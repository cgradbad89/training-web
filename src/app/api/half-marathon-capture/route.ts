import { handleCaptureRequest } from '../../../../tools/race-validation/capture-service'

// Inert unless the server-only HM_CAPTURE_ENABLED variable is exactly "true".
// See docs/half-marathon-capture-activation-phase3f.md.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export function GET(request: Request) {
  return handleCaptureRequest(request, { env: process.env })
}
