import { TRAINING_APP_URL, type HubSummary, type TrainingData } from "@/lib/hub-contract";
import { HubReadError, readHubWeek } from "@/lib/hubAdminReader";
import { deriveTrainingWeek } from "@/lib/hubTrainingWeek";
import { HUB_TIME_ZONE, zonedWeekFor } from "@/lib/hubWeek";
import { verifyHubOwner } from "@/lib/hubOwnerAuth";

/**
 * GET /api/hub/summary — the Training tile of my-hub's weekly dashboard.
 *
 * Read-only: verifies the forwarded Firebase ID token, applies the single-owner
 * rule, reads that user's current Eastern week with the Admin SDK and returns a
 * HubSummary<TrainingData> envelope. There is no cache layer and nothing is
 * ever written. The numbers come from the same shared weekly functions the
 * Dashboard uses (see `src/lib/hubTrainingWeek.ts` and its parity test).
 *
 * 401 missing/invalid token · 403 valid but not the owner · 405 non-GET ·
 * 200 envelope otherwise ("unavailable" for permission/upstream/timeout).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Total budget per request; the hub itself gives up after 15 s. (Not exported: a route module may only export handlers and route config.) */
const HUB_SUMMARY_DEADLINE_MS = 10_000;

const BASE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization",
} as const;

type Outcome = "ok" | "unavailable" | "timeout" | "error" | "denied";
type UnavailableReason = "permission" | "upstream" | "timeout";

interface Timing {
  stages: { auth: number; workouts: number; overrides: number; plans: number; summary: number };
  counts: { workouts: number; overrides: number; plans: number };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...BASE_HEADERS, ...extra },
  });
}

/** One line per request; fixed field names and integers only. */
function logTiming(outcome: Outcome, started: number, timing: Timing): void {
  const { stages: s, counts: c } = timing;
  console.info(
    `[hub-summary] timing outcome=${outcome} total_ms=${Date.now() - started} ` +
      `stages=auth:${s.auth},workouts:${s.workouts},overrides:${s.overrides},plans:${s.plans},summary:${s.summary} ` +
      `counts=workouts:${c.workouts},overrides:${c.overrides},plans:${c.plans}`
  );
}

function unavailable(reason: UnavailableReason, now: Date): Response {
  const body: HubSummary<TrainingData> = {
    status: "unavailable",
    app: "training",
    generatedAt: now.toISOString(),
    reason,
  };
  return json(body, 200);
}

class DeadlineError extends Error {}

export async function GET(request: Request): Promise<Response> {
  const started = Date.now();
  const now = new Date();
  const timing: Timing = {
    stages: { auth: 0, workouts: 0, overrides: 0, plans: 0, summary: 0 },
    counts: { workouts: 0, overrides: 0, plans: 0 },
  };

  const authStart = Date.now();
  const auth = await verifyHubOwner(request);
  timing.stages.auth = Date.now() - authStart;
  if (!auth.ok) {
    logTiming(auth.status === 500 ? "error" : "denied", started, timing);
    return json({ error: auth.error }, auth.status);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const week = zonedWeekFor(now, HUB_TIME_ZONE);
      const read = await readHubWeek(auth.uid, week);
      timing.stages.workouts = read.stagesMs.workouts;
      timing.stages.overrides = read.stagesMs.overrides;
      timing.stages.plans = read.stagesMs.plans;
      timing.counts = read.counts;
      const summaryStart = Date.now();
      const { periodLabel, data } = deriveTrainingWeek({
        plans: read.plans,
        workouts: read.workouts,
        overrides: read.overrides,
        now,
        timeZone: HUB_TIME_ZONE,
      });
      timing.stages.summary = Date.now() - summaryStart;
      return { periodLabel, data };
    })();
    // If the deadline wins, the abandoned work must not surface as an unhandled rejection.
    work.catch(() => undefined);

    const remaining = Math.max(1, HUB_SUMMARY_DEADLINE_MS - (Date.now() - started));
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError()), remaining);
    });
    const { periodLabel, data } = await Promise.race([work, deadline]);

    const body: HubSummary<TrainingData> = {
      status: "ok",
      app: "training",
      generatedAt: now.toISOString(),
      periodLabel,
      appUrl: TRAINING_APP_URL,
      data,
    };
    logTiming("ok", started, timing);
    return json(body, 200);
  } catch (error) {
    if (error instanceof DeadlineError) {
      logTiming("timeout", started, timing);
      return unavailable("timeout", now);
    }
    if (error instanceof HubReadError) {
      console.error(`[hub-summary] read failed reason=${error.reason}`);
      logTiming("unavailable", started, timing);
      return unavailable(error.reason, now);
    }
    // Unexpected failure: fixed marker only — never the message, stack or any id.
    console.error("[hub-summary] unexpected failure");
    logTiming("error", started, timing);
    return json({ error: "Server error" }, 500);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function methodNotAllowed(): Response {
  console.info("[hub-summary] timing outcome=denied total_ms=0 stages=auth:0,workouts:0,overrides:0,plans:0,summary:0 counts=workouts:0,overrides:0,plans:0");
  return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
