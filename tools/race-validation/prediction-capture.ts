import { performance } from 'node:perf_hooks';
import { canonicalizePerformanceValue } from '@/utils/performanceEvidence';
import { calculateValidation, evaluationVersion, type ValidationFlags } from './prediction-models';
import { digest, instant } from './evidence';
import { inCaptureWindow, reportingDate, validationObject, validationSlots, VALIDATION_PROTOCOL, VALIDATION_TIME_ZONE, type ScheduledRace, type ValidationSlot } from './prediction-schedule';
import type { ValidationSource } from './prediction-source';
import type { StoredCapture } from './scheduled-capture';

export interface ValidationStore {
  verifyPolicy(): Promise<unknown>;
  read(name: string): Promise<StoredCapture | null>;
  create(name: string, artifact: unknown): Promise<'created' | 'exists'>;
}
export interface ValidationCaptureConfig {
  codeRevision: string; flags: ValidationFlags; startDate: string;
}
export interface ValidationPorts {
  now(): string;
  metadata(): Promise<{ races: ScheduledRace[]; documentsRead: number; minimumReads: number }>;
  evidence(now: string, hydrate: boolean): Promise<ValidationSource>;
  store: ValidationStore;
}
export function sealValidation<T extends object>(payload: T) { return { ...payload, integrityDigest: digest(payload) }; }
export function verifyValidation(value: unknown): ValidationCapture {
  if (!value || typeof value !== 'object') throw new Error('Invalid validation record');
  const { integrityDigest, ...payload } = value as Record<string, unknown>;
  if (payload.protocol !== VALIDATION_PROTOCOL || integrityDigest !== digest(payload) || !Array.isArray(payload.snapshots)
    || !payload.predictions || !['complete', 'incomplete'].includes(String(payload.status))) throw new Error('Invalid validation integrity');
  return value as ValidationCapture;
}

function makeCapture(config: ValidationCaptureConfig, source: ValidationSource, slots: ValidationSlot[], attempts: number, elapsedMs: number, cpuMs: number,
  metadataReads: number, metadataMinimumReads: number, retentionLocked: boolean, readAccountingComplete: boolean) {
  const predictions = calculateValidation(source.input, source.discovered, config.flags);
  const payload = {
    protocol: VALIDATION_PROTOCOL, evaluationVersion: evaluationVersion(config.flags), applicationRevision: config.codeRevision,
    reportingDate: reportingDate(source.input.asOf), timeZone: VALIDATION_TIME_ZONE,
    evaluatedAt: source.input.asOf, evidenceCutoff: source.input.asOf, completedAt: source.input.asOf,
    storage: { retentionLocked, deletionProtection: retentionLocked ? 'locked_retention' : 'unlocked_pilot_retention' },
    status: source.limitations.length ? 'incomplete' as const : 'complete' as const, limitations: source.limitations,
    snapshots: slots.map(slot => ({ ...slot, takenBeforeRace: slot.race ? reportingDate(source.input.asOf) < slot.race.raceDate : null })),
    predictions, evidenceDigest: source.evidenceDigest,
    usage: { ...source.usage, metadataDocumentsRead: metadataReads, metadataMinimumReads,
      functionDurationMs: elapsedMs, processCpuMs: cpuMs,
      durationScope: 'capture through calculation; excludes final storage IO and legacy collector', cpuBasis: 'process.cpuUsage; includes concurrent work in this process',
      attempts, readAccountingComplete, snapshotBytes: 0, gcsCaptureWrites: 1 },
  };
  return sealValidation(payload);
}
export type ValidationCapture = ReturnType<typeof makeCapture>;

/** At most two create-only attempt claims per Eastern date/model version, across all concurrent invocations. */
export async function runPredictionCapture(config: ValidationCaptureConfig, ports: ValidationPorts, dryRun = false) {
  const invokedAt = instant(ports.now(), 'invokedAt'), date = reportingDate(invokedAt), version = evaluationVersion(config.flags);
  if (date < config.startDate || !inCaptureWindow(invokedAt)) return { status: 'idle' };
  const started = performance.now(), cpu = process.cpuUsage();
  const name = validationObject(date, version);
  const policy = await ports.store.verifyPolicy();
  const retentionLocked = !!(policy && typeof policy === 'object' && 'retentionLocked' in policy && policy.retentionLocked === true);
  const existing = await ports.store.read(name);
  if (existing) { verifyValidation(existing.artifact); return { status: 'duplicate', generation: existing.generation }; }
  const metadata = await ports.metadata();
  const scheduled = validationSlots(date, metadata.races, version);
  if (!scheduled.length) return { status: 'idle', metadataDocumentsRead: metadata.documentsRead };
  const eligible = (at: string) => reportingDate(at) === date && inCaptureWindow(at);
  const attempts = dryRun ? [0] : [1, 2];
  const attemptUsage: { attempt: number; usage: ValidationSource['usage'] | null; accountingComplete: boolean }[] = [];
  for (const attempt of attempts) {
    if (!eligible(ports.now())) return { status: 'missed', reason: 'capture_window_closed' };
    if (!dryRun) {
      const claimName = validationObject(date, version, `claim-${attempt}`);
      const claim = await ports.store.read(claimName);
      if (claim) {
        // An unfinished claim may still be running: NEVER overlap full hydration. Vercel maxDuration=300s.
        const failure = await ports.store.read(validationObject(date, version, `failure-${attempt}`));
        if (!failure && Date.parse(ports.now()) - Date.parse(claim.createdAt) < 330_000) return { status: 'in_progress' };
        continue;
      }
      const disposition = await ports.store.create(claimName, { protocol: VALIDATION_PROTOCOL, status: 'started', invokedAt,
        snapshots: scheduled, evaluationVersion: version, applicationRevision: config.codeRevision });
      if (disposition === 'exists') return { status: 'in_progress' };
    }
    try {
      const source = await ports.evidence(ports.now(), config.flags.physiology);
      attemptUsage.push({ attempt, usage: source.usage, accountingComplete: true });
      if (source.input.asOf < invokedAt || source.input.asOf > ports.now() || !eligible(source.input.asOf) || !eligible(ports.now()))
        throw new Error('Invalid evidence timestamp');
      // Revalidate cancellation/reschedule inside the consistent evidence read, before sealing.
      const slots = validationSlots(date, source.discovered, version);
      if (!slots.length) throw new Error('Race enrollment changed');
      // Sum all attempts performed by this invocation. Prior interrupted invocations retain their own receipts.
      source.usage = { ...source.usage, documents: {}, queryMinimumReads: 0 };
      for (const entry of attemptUsage) if (entry.usage) {
        source.usage.queryMinimumReads += entry.usage.queryMinimumReads;
        for (const [collection, count] of Object.entries(entry.usage.documents)) source.usage.documents[collection] = (source.usage.documents[collection] ?? 0) + count;
      }
      const elapsed = process.cpuUsage(cpu);
      const record = makeCapture(config, source, slots, attempt, performance.now() - started, (elapsed.user + elapsed.system) / 1000,
        metadata.documentsRead, metadata.minimumReads, retentionLocked, attemptUsage.every(a => a.accountingComplete));
      record.completedAt = ports.now();
      const measuredCpu = process.cpuUsage(cpu);
      record.usage.functionDurationMs = performance.now() - started;
      record.usage.processCpuMs = (measuredCpu.user + measuredCpu.system) / 1000;
      const measure = () => {
        const payload = { ...record } as Partial<typeof record>;
        delete payload.integrityDigest;
        record.integrityDigest = digest(payload);
        return Buffer.byteLength(canonicalizePerformanceValue(record));
      };
      // Include the digest and the size field itself in the measured stored JSON size.
      for (let i = 0; i < 5; i++) { const size = measure(); if (size === record.usage.snapshotBytes) break; record.usage.snapshotBytes = size; }
      measure();
      if (record.usage.snapshotBytes > 192 * 1024) throw new Error('Compact snapshot budget exceeded');
      if (dryRun) return { status: 'dry_run', record, writes: 0 };
      if (!eligible(ports.now())) throw new Error('Capture window closed');
      await ports.store.create(name, record);
      const stored = await ports.store.read(name);
      if (!stored) throw new Error('Missing stored generation');
      const verified = verifyValidation(stored.artifact);
      if (verified.evaluationVersion !== version || verified.reportingDate !== date || verified.evaluatedAt > stored.createdAt)
        throw new Error('Invalid stored generation');
      return { status: verified.status, generation: stored.generation, usage: verified.usage };
    } catch (error) {
      if (!attemptUsage.some(a => a.attempt === attempt)) {
        const failed = error as { usage?: ValidationSource['usage']; accountingComplete?: boolean };
        attemptUsage.push({ attempt, usage: failed?.usage ?? null, accountingComplete: false });
      }
      if (dryRun) return { status: 'failed', reason: 'evaluation_failed', writes: 0 };
      // Never persist an exception message or source payload. Claims and failure receipts are append-only too.
      await ports.store.create(validationObject(date, version, `failure-${attempt}`), { protocol: VALIDATION_PROTOCOL,
        status: 'failed', reason: 'evaluation_or_verification_failed', attempt, observedAt: ports.now(), snapshots: scheduled, usage: attemptUsage.find(a => a.attempt === attempt) });
      const saved = await ports.store.read(name);
      if (saved) { verifyValidation(saved.artifact); return { status: 'duplicate', generation: saved.generation }; }
    }
  }
  return { status: 'failed', reason: 'attempt_budget_exhausted' };
}
