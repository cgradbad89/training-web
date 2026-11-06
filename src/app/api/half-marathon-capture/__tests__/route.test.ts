// @vitest-environment node
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../route'

afterEach(() => vi.unstubAllEnvs())

describe('half-marathon capture route', () => {
  it('is inert and reveals nothing unless explicitly enabled', async () => {
    vi.stubEnv('HM_CAPTURE_ENABLED', '')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const headers of [{}, { authorization: 'Bearer anything' }]) {
      const response = await GET(new Request('https://example.invalid/api/half-marathon-capture', { headers }))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ status: 'disabled' })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('rejects unauthenticated callers before any work when enabled with valid configuration', async () => {
    const values: Record<string, string> = {
      HM_CAPTURE_ENABLED: 'true', CRON_SECRET: 'synthetic-route-secret-that-is-long-enough', HM_CAPTURE_PROJECT_ID: 'p',
      HM_CAPTURE_OWNER_UID: 'u', HM_CAPTURE_SUBJECT: 's', HM_CAPTURE_RACE_ID: 'r', HM_CAPTURE_AUTHORIZATION: 'a', HM_CAPTURE_BUCKET: 'bucket-name',
      HM_CAPTURE_WIF_AUDIENCE: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/pool-1/providers/prov-1',
      HM_CAPTURE_WRITER_SA: 'w-account@p.iam.gserviceaccount.com', HM_CAPTURE_VERIFIER_SA: 'v-account@p.iam.gserviceaccount.com',
      HM_CAPTURE_READER_SA: 'r-account@p.iam.gserviceaccount.com',
    }
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await GET(new Request('https://example.invalid/api/half-marathon-capture'))
    expect(response.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('schedules three daily slots that stay inside the New York checkpoint day', () => {
    const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] }
    expect(crons.map(cron => cron.path)).toEqual(Array(3).fill('/api/half-marathon-capture'))
    expect(crons.map(cron => cron.schedule)).toEqual(['0 13 * * *', '0 17 * * *', '0 21 * * *'])
  })
})
