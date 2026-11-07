/**
 * Session-scoped, in-memory stores for the hybrid v1.1 physiological inputs (Apple Health VO₂ max and warm-up-trimmed
 * HR-stream summaries). No Firestore import here: the fetchers are injected (see `physiologyEvidenceFirestore.ts`), which keeps
 * the read-bounding, deduplication, isolation and failure rules unit-testable.
 *
 * Guarantees (each is covered by a test):
 *  - ISOLATION  every entry is keyed by `${uid}:${sessionEpoch}`; a different user or a new sign-in drops all prior entries, and
 *               a result that settles after the session changed is discarded (never delivered, never cached).
 *  - DEDUP      concurrent requests for the same key share one in-flight promise; a repeated visit inside the TTL reads nothing.
 *  - BOUNDS     VO₂: one windowed query. Streams: at most `maxRuns` per request, `maxChunksPerRun` chunk documents per stream (a stream
 *               that hits the bound is DISCARDED as truncated — a prefix would bias the trimmed mean), `maxTotalChunkReads` per session,
 *               `concurrency` parallel reads. Nothing is read for a workout that cannot influence the model (see `hrStreamSelection.ts`).
 *  - FAILURE    a failed read is reported as failed — never replaced by a plausible value — and cached for a short cooldown so a
 *               re-render loop cannot hammer Firestore. A permission error is never retried inside the session.
 *  - FRESHNESS  VO₂ is cached for `ttlMs`; a stream summary is keyed by the workout's own change fingerprint (a corrected workout
 *               is re-hydrated) and holds only the SUMMARY, never raw samples.
 */
import type { HrSample, HrStreamSummary } from "@/types/hybridPerformance";
import type { Vo2Entry } from "@/utils/vo2History";
import { summarizeHrStream } from "@/utils/performance/hrStreamQuality";
import type { StreamCandidate } from "@/utils/performance/hrStreamSelection";

export const PHYSIOLOGY_LIMITS = Object.freeze({
  vo2WindowDays: 70, vo2TtlMs: 30 * 60_000, failureCooldownMs: 2 * 60_000,
  maxRuns: 16, maxChunksPerRun: 40, maxTotalChunkReads: 400, concurrency: 3,
});

export type FetchFailure = { kind: "permission" | "network"; message: string };
const classify = (e: unknown): FetchFailure => {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
  return { kind: /permission/i.test(code) ? "permission" : "network", message: e instanceof Error ? e.message : String(e) };
};

export type Vo2Result = { state: "loaded"; entries: Vo2Entry[]; docsRead: number } | { state: "failed"; failure: FetchFailure };
export interface Vo2Fetcher { (uid: string, now: Date): Promise<{ entries: Vo2Entry[]; docsRead: number }> }

export class Vo2EvidenceStore {
  private owner: string | null = null;
  private cached: { at: number; result: Vo2Result } | null = null;
  private inflight: Promise<Vo2Result> | null = null;
  reads = 0;
  constructor(private fetcher: Vo2Fetcher, private now: () => number = Date.now) {}

  private claim(key: string) { if (this.owner !== key) { this.owner = key; this.cached = null; this.inflight = null; this.reads = 0; } }

  async load(uid: string, sessionEpoch: number, isCurrent: () => boolean): Promise<Vo2Result | null> {
    const key = `${uid}:${sessionEpoch}`;
    this.claim(key);
    const hit = this.cached;
    if (hit && this.now() - hit.at < (hit.result.state === "loaded" ? PHYSIOLOGY_LIMITS.vo2TtlMs : this.cooldown(hit.result))) return hit.result;
    if (!this.inflight) {
      const run = (async (): Promise<Vo2Result> => {
        try { const r = await this.fetcher(uid, new Date(this.now())); this.reads += r.docsRead; return { state: "loaded", entries: r.entries, docsRead: r.docsRead }; }
        catch (e) { return { state: "failed", failure: classify(e) }; }
      })();
      this.inflight = run;
      run.then(result => { if (this.owner === key && this.inflight === run) { this.cached = { at: this.now(), result }; this.inflight = null; } });
    }
    const result = await this.inflight;
    return isCurrent() && this.owner === key ? result : null;
  }
  /** A permission failure is not retried within the session. */
  private cooldown(r: Vo2Result) { return r.state === "failed" && r.failure.kind === "permission" ? Number.POSITIVE_INFINITY : PHYSIOLOGY_LIMITS.failureCooldownMs; }
}

export interface StreamFetcher { (uid: string, workoutId: string, maxChunks: number): Promise<{ samples: HrSample[]; chunks: number }> }
export type StreamOutcome = { state: "summarized"; summary: HrStreamSummary } | { state: "failed"; failure: FetchFailure } | { state: "skipped_budget" };
export interface HydrationReport {
  summaries: Record<string, HrStreamSummary>;
  requested: number; fromCache: number; fetched: number; failed: number; skippedBudget: number; chunkReads: number;
  /** "loaded" when at least one summary exists or nothing was requested; "failed" when every requested read failed. */
  state: "loaded" | "failed";
}

export class HrStreamEvidenceStore {
  private owner: string | null = null;
  private done = new Map<string, { at: number; outcome: StreamOutcome }>();
  private inflight = new Map<string, Promise<StreamOutcome>>();
  private chunkReadsTotal = 0;
  constructor(private fetcher: StreamFetcher, private now: () => number = Date.now, private summarize: (s: readonly HrSample[]) => HrStreamSummary = summarizeHrStream) {}

  get totalChunkReads() { return this.chunkReadsTotal; }
  private claim(key: string) { if (this.owner !== key) { this.owner = key; this.done.clear(); this.inflight.clear(); this.chunkReadsTotal = 0; } }

  private cached(id: string): StreamOutcome | null {
    const hit = this.done.get(id);
    if (!hit) return null;
    if (hit.outcome.state === "summarized") return hit.outcome;
    if (hit.outcome.state === "failed") return hit.outcome.failure.kind === "permission" || this.now() - hit.at < PHYSIOLOGY_LIMITS.failureCooldownMs ? hit.outcome : null;
    return null; // a budget skip is re-evaluated (the budget only shrinks, so it will skip again unless it was a fresh session)
  }

  async hydrate(uid: string, sessionEpoch: number, isCurrent: () => boolean, candidates: readonly StreamCandidate[]): Promise<HydrationReport | null> {
    const key = `${uid}:${sessionEpoch}`;
    this.claim(key);
    const L = PHYSIOLOGY_LIMITS, list = candidates.slice(0, L.maxRuns);
    const report: HydrationReport = { summaries: {}, requested: list.length, fromCache: 0, fetched: 0, failed: 0, skippedBudget: 0, chunkReads: 0, state: "loaded" };
    const queue = [...list];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const id = `${c.cacheKey}`;
        const hit = this.cached(id);
        let outcome: StreamOutcome;
        let fresh = false;
        if (hit) { outcome = hit; report.fromCache++; }
        else if (this.chunkReadsTotal >= L.maxTotalChunkReads) outcome = { state: "skipped_budget" };
        else {
          let p = this.inflight.get(id);
          if (!p) {
            fresh = true;
            p = (async (): Promise<StreamOutcome> => {
              try {
                const r = await this.fetcher(uid, c.workoutId, L.maxChunksPerRun);
                if (this.owner === key) this.chunkReadsTotal += r.chunks;
                report.chunkReads += r.chunks;
                // A stream that reached the chunk bound is a prefix of the workout: discarded, never summarized.
                if (r.chunks >= L.maxChunksPerRun) return { state: "summarized", summary: { ...this.summarize([]), flags: ["stream_truncated_by_read_bound"] } };
                return { state: "summarized", summary: this.summarize(r.samples) };
              } catch (e) { return { state: "failed", failure: classify(e) }; }
            })();
            this.inflight.set(id, p);
          }
          outcome = await p;
          if (this.owner === key) { this.done.set(id, { at: this.now(), outcome }); this.inflight.delete(id); }
          if (fresh) report.fetched++;
        }
        if (outcome.state === "summarized") report.summaries[c.workoutId] = outcome.summary;
        else if (outcome.state === "failed") report.failed++;
        else report.skippedBudget++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(L.concurrency, list.length) }, worker));
    if (!isCurrent() || this.owner !== key) return null;
    report.state = report.requested > 0 && report.failed === report.requested ? "failed" : "loaded";
    return report;
  }
}
