"use client";

import {
  type RunImpact,
  type CtlImpact,
  IMPACT_MIN_DISPLAY_SECONDS,
} from "@/utils/runImpact";
import { formatRaceTime } from "@/utils/riegelFit";
import { parseLocalDate } from "@/utils/dates";
import { formatImpactDelta, type CurrentHalfRunImpact } from "@/utils/currentHalfRunImpact";
import type { CurrentImpactCard } from "@/hooks/useCurrentHalfRunImpact";
import type { HrImpactCard } from "@/hooks/useHrEnhancedRunImpact";

interface RunImpactSectionProps {
  /** Race-prediction tile inputs; null hides the tile (no active race or no
   *  current prediction). */
  prediction: {
    impact: RunImpact;
    raceName: string;
    raceDateIso: string;
  } | null;
  /** Fitness (CTL) tile inputs; null hides the tile. */
  ctl: CtlImpact | null;
  /** Explains abstention without replacing it with a legacy prediction. */
  predictionUnavailableReason?: string | null;
  /** Current half-marathon estimate impact (experimental-current-hm-v2). When
   *  present it owns the prediction slot; the legacy tile is never rendered. */
  currentEstimate?: CurrentImpactCard | null;
  /** Experimental HR-enhanced estimate impact (same-model with/without). Shown BESIDE, never merged into, the official tile. */
  hrEnhancedEstimate?: HrImpactCard | null;
}

const MODEL_INFLUENCE_NOTE = "Shows how this run changes the current model estimate, not a measured fitness gain.";
const UNAVAILABLE_TITLE = {
  no_races: "No race result to anchor an estimate",
  no_anchor: "No usable race anchor",
  anchor_expired: "Race anchor expired",
  insufficient_evidence: "Insufficient evidence",
} as const;

/** The application's established "~H:MM" estimate formatting (minute-rounded). */
function estimateLabel(minutes: number): string {
  return `~${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function CurrentEstimateTile({ card }: { card: CurrentImpactCard }) {
  const header = (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide">
        Current half-marathon estimate
      </span>
      <span className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-textSecondary">
        Experimental
      </span>
    </div>
  );
  const shell = (children: React.ReactNode) => (
    <div className="bg-surface rounded-xl p-4 flex flex-col gap-1.5 min-w-0" data-testid="current-estimate-impact">
      {header}
      {children}
    </div>
  );

  if (card.state === "loading") {
    return shell(<p role="status" className="text-xs text-textSecondary">Calculating this run&rsquo;s impact on the current estimate&hellip;</p>);
  }
  if (card.state === "error") {
    return shell(<p role="alert" className="text-xs text-textSecondary">{card.message}</p>);
  }

  const impact: CurrentHalfRunImpact = card.impact;
  const notice = card.notice && <p role="status" className="text-[10px] text-textSecondary">{card.notice}</p>;
  const note = <span className="text-[10px] text-textSecondary">{MODEL_INFLUENCE_NOTE}</span>;

  if (impact.kind === "unavailable") {
    return shell(<>
      <span className="text-sm font-semibold text-textPrimary" data-testid="impact-state">{UNAVAILABLE_TITLE[impact.cause]}</span>
      <p className="text-xs text-textSecondary">{impact.reason}</p>
      <p className="text-[10px] text-textSecondary">Only this estimate is unavailable; the rest of this run&rsquo;s details are unaffected.</p>
      {notice}
    </>);
  }
  if (impact.kind === "not_evidence" || impact.kind === "unsupported") {
    return shell(<>
      <span className="text-xl font-bold text-textPrimary tabular-nums" data-testid="impact-with">{estimateLabel(impact.withMinutes)}</span>
      <span className="text-sm font-semibold text-textPrimary" data-testid="impact-state">
        {impact.kind === "unsupported" ? "Comparison not supported" : "Not a training input to the estimate"}
      </span>
      <p className="text-xs text-textSecondary">{impact.reason}</p>
      {note}{notice}
    </>);
  }

  const tone = impact.direction === "faster" ? "text-success" : impact.direction === "slower" ? "text-warning" : "text-textSecondary";
  const magnitude = Math.abs(impact.deltaSeconds);
  const negligible = impact.direction !== "unchanged" && magnitude < 1;
  const verdict = impact.direction === "unchanged" ? "No change in the model estimate"
    : `${impact.direction === "faster" ? "Faster" : "Slower"} by ${formatImpactDelta(magnitude)}${negligible ? " (negligible)" : ""}`;
  return shell(<>
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
      <div className="flex flex-col">
        <dt className="text-[10px] text-textSecondary">Without this run</dt>
        <dd className="text-sm text-textSecondary" data-testid="impact-without">{estimateLabel(impact.withoutMinutes)}</dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[10px] text-textSecondary">With this run</dt>
        <dd className="text-xl font-bold text-textPrimary" data-testid="impact-with">{estimateLabel(impact.withMinutes)}</dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[10px] text-textSecondary">Difference</dt>
        <dd className={`text-sm font-semibold ${tone}`} data-testid="impact-delta">
          {impact.direction === "unchanged" ? "None" : `${impact.direction === "faster" ? "▼" : "▲"} ${formatImpactDelta(magnitude)}`}
        </dd>
      </div>
    </dl>
    <span className={`text-xs font-semibold ${tone}`} data-testid="impact-state">{verdict}</span>
    {impact.direction === "unchanged" && (
      <p className="text-xs text-textSecondary">
        This run does not change the current estimate
        {impact.runAgeDays != null && impact.runAgeDays > 56
          ? `. It is ${impact.runAgeDays} days old and may fall outside the training windows the model uses.`
          : "."}
      </p>
    )}
    <span className="text-[10px] text-textSecondary">Estimates are rounded to the minute; the difference uses unrounded model values.</span>
    {note}{notice}
  </>);
}


/** Separate, clearly experimental tile: HR-enhanced with/without comparison (never mixed with the official delta). */
function HrEnhancedImpactTile({ card }: { card: HrImpactCard }) {
  const shell = (children: React.ReactNode) => (
    <div className="bg-surface rounded-xl p-4 flex flex-col gap-1.5 min-w-0" data-testid="hr-enhanced-impact">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide">HR-enhanced estimate</span>
        <span className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-textSecondary">Experimental</span>
      </div>
      {children}
      <span className="text-[10px] text-textSecondary">Experimental and not independently validated; the official estimate above is unaffected.</span>
    </div>
  );
  if (card.state === "loading") return shell(<p role="status" className="text-xs text-textSecondary">Calculating&hellip;</p>);
  if (card.state === "error") return shell(<p role="alert" className="text-xs text-textSecondary">{card.message}</p>);
  const i = card.impact;
  if (i.kind === "unavailable") return shell(<><span className="text-sm font-semibold text-textPrimary" data-testid="hr-impact-state">Not available</span><p className="text-xs text-textSecondary">{i.reason}</p></>);
  if (i.kind === "not_evidence" || i.kind === "unsupported") return shell(<>
    <span className="text-xl font-bold text-textPrimary tabular-nums" data-testid="hr-impact-with">{estimateLabel(i.withMinutes)}</span>
    <span className="text-sm font-semibold text-textPrimary" data-testid="hr-impact-state">{i.kind === "unsupported" ? "Comparison not supported" : "Not a training input"}</span>
    <p className="text-xs text-textSecondary">{i.reason}</p></>);
  const tone = i.direction === "faster" ? "text-success" : i.direction === "slower" ? "text-warning" : "text-textSecondary";
  const magnitude = Math.abs(i.deltaSeconds);
  return shell(<>
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
      <div className="flex flex-col"><dt className="text-[10px] text-textSecondary">Without this run</dt><dd className="text-sm text-textSecondary" data-testid="hr-impact-without">{estimateLabel(i.withoutMinutes)}</dd></div>
      <div className="flex flex-col"><dt className="text-[10px] text-textSecondary">With this run</dt><dd className="text-xl font-bold text-textPrimary" data-testid="hr-impact-with">{estimateLabel(i.withMinutes)}</dd></div>
      <div className="flex flex-col"><dt className="text-[10px] text-textSecondary">Difference</dt>
        <dd className={`text-sm font-semibold ${tone}`} data-testid="hr-impact-delta">{i.direction === "unchanged" ? "None" : `${i.direction === "faster" ? "▼" : "▲"} ${formatImpactDelta(magnitude)}`}</dd></div>
    </dl>
    <span className={`text-xs font-semibold ${tone}`} data-testid="hr-impact-state">
      {i.direction === "unchanged" ? "No change in the HR-enhanced estimate" : `${i.direction === "faster" ? "Faster" : "Slower"} by ${formatImpactDelta(magnitude)}`}
    </span>
    <span className="text-[10px] text-textSecondary">Same-model comparison (heart-rate evidence included). Estimates are rounded to the minute; the difference uses unrounded values.</span>
  </>);
}

/** "31s" under a minute, else "1:31" (m:ss). Deltas are small by nature. */
function deltaSecondsLabel(absSeconds: number): string {
  const s = Math.round(absSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function formatRaceDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * "This Run's Impact" — with/without-this-run deltas for the active race
 * prediction and today's CTL. Deltas are HONEST (approved product decision):
 * a run that worsens the prediction shows its unfavorable delta in the
 * negative color, never suppressed.
 */
export function RunImpactSection({ prediction, ctl, predictionUnavailableReason, currentEstimate, hrEnhancedEstimate }: RunImpactSectionProps) {
  if (!prediction && !ctl && !predictionUnavailableReason && !currentEstimate) return null;

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <h2 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-3">
        This Run&rsquo;s Impact
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {currentEstimate ? (
          <>
            <CurrentEstimateTile card={currentEstimate} />
            {hrEnhancedEstimate && <HrEnhancedImpactTile card={hrEnhancedEstimate} />}
          </>
        ) : predictionUnavailableReason ? (
          <div className="bg-surface rounded-xl p-4 flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide">
              Race-performance impact
            </span>
            <span className="text-sm font-semibold text-textPrimary">Numerical estimate unavailable</span>
            <p className="text-xs text-textSecondary">{predictionUnavailableReason}</p>
          </div>
        ) : prediction && (
          <div className="bg-surface rounded-xl p-4 flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide">
              🎯 {prediction.raceName} Prediction &middot;{" "}
              {formatRaceDate(prediction.raceDateIso)}
            </span>
            {(() => {
              const imp = prediction.impact;

              // State 3 — out of window: too short/old to feed the model.
              if (!imp.affectsProjection) {
                return (
                  <>
                    <span className="text-xl font-bold text-textPrimary tabular-nums">
                      {formatRaceTime(imp.withRunSeconds)}
                    </span>
                    <span className="text-[10px] text-textSecondary">
                      This run doesn&rsquo;t affect your current projection
                    </span>
                  </>
                );
              }

              // In-window but the remaining history can't fit without this run.
              if (imp.withoutRunSeconds == null || imp.deltaSeconds == null) {
                return (
                  <>
                    <span className="text-xl font-bold text-textPrimary tabular-nums">
                      {formatRaceTime(imp.withRunSeconds)}
                    </span>
                    <span className="text-[10px] text-textSecondary">
                      Not enough history without this run
                    </span>
                  </>
                );
              }

              const delta = imp.deltaSeconds;

              // State 2 — minimal impact: in-window easy run below the threshold.
              if (Math.abs(delta) < IMPACT_MIN_DISPLAY_SECONDS) {
                return (
                  <>
                    <span className="text-xl font-bold text-textPrimary tabular-nums">
                      {formatRaceTime(imp.withRunSeconds)}
                    </span>
                    <span className="text-[10px] text-textSecondary">
                      Minimal impact on your projection
                    </span>
                  </>
                );
              }

              // State 1 — meaningful impact: without → with + honest delta.
              // Negative delta = this run made the projection FASTER.
              return (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm text-textSecondary line-through tabular-nums">
                      {formatRaceTime(imp.withoutRunSeconds)}
                    </span>
                    <span className="text-xs text-textSecondary">&rarr;</span>
                    <span className="text-xl font-bold text-textPrimary tabular-nums">
                      {formatRaceTime(imp.withRunSeconds)}
                    </span>
                    {delta < 0 ? (
                      <span className="text-sm font-semibold text-success tabular-nums">
                        ▼ {deltaSecondsLabel(Math.abs(delta))}
                      </span>
                    ) : (
                      // Slower projection (run nudged the prediction up): amber
                      // caution, not red — a single slow run isn't a failure.
                      // Token is --color-warning (the codebase's amber); there
                      // is no --color-caution utility in the Tailwind v4 theme.
                      <span className="text-sm font-semibold text-warning tabular-nums">
                        ▲ {deltaSecondsLabel(delta)}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-textSecondary">
                    Prediction recomputed with this run vs. without it
                  </span>
                </>
              );
            })()}
          </div>
        )}

        {ctl && (
          <div className="bg-surface rounded-xl p-4 flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide">
              📈 Fitness (CTL)
            </span>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm text-textSecondary line-through tabular-nums">
                {ctl.withoutCtl.toFixed(1)}
              </span>
              <span className="text-xs text-textSecondary">&rarr;</span>
              <span className="text-xl font-bold text-textPrimary tabular-nums">
                {ctl.withCtl.toFixed(1)}
              </span>
              {(() => {
                if (Math.abs(ctl.delta) < 0.05) {
                  return (
                    <span className="text-xs font-semibold text-textSecondary">
                      No change
                    </span>
                  );
                }
                return ctl.delta > 0 ? (
                  <span className="text-sm font-semibold text-success tabular-nums">
                    ▲ {ctl.delta.toFixed(1)}
                  </span>
                ) : (
                  <span className="text-sm font-semibold text-danger tabular-nums">
                    ▼ {Math.abs(ctl.delta).toFixed(1)}
                  </span>
                );
              })()}
            </div>
            <span className="text-[10px] text-textSecondary">
              42-day load contribution from this run
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
