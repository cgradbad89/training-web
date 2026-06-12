"use client";

import { type PredictionImpact, type CtlImpact } from "@/utils/runImpact";
import { formatRaceTime } from "@/utils/riegelFit";
import { parseLocalDate } from "@/utils/dates";

interface RunImpactSectionProps {
  /** Race-prediction tile inputs; null hides the tile (no active race or no
   *  current prediction). */
  prediction: {
    impact: PredictionImpact;
    raceName: string;
    raceDateIso: string;
  } | null;
  /** Fitness (CTL) tile inputs; null hides the tile. */
  ctl: CtlImpact | null;
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
export function RunImpactSection({ prediction, ctl }: RunImpactSectionProps) {
  if (!prediction && !ctl) return null;

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <h2 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-3">
        This Run&rsquo;s Impact
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {prediction && (
          <div className="bg-surface rounded-xl p-4 flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide">
              🎯 {prediction.raceName} Prediction &middot;{" "}
              {formatRaceDate(prediction.raceDateIso)}
            </span>
            {prediction.impact.withoutSeconds == null ? (
              <p className="text-sm text-textSecondary py-1.5">
                Not enough history without this run
              </p>
            ) : (
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm text-textSecondary line-through tabular-nums">
                  {formatRaceTime(prediction.impact.withoutSeconds)}
                </span>
                <span className="text-xs text-textSecondary">&rarr;</span>
                <span className="text-xl font-bold text-textPrimary tabular-nums">
                  {formatRaceTime(prediction.impact.withSeconds)}
                </span>
                {prediction.impact.deltaSeconds != null &&
                  (() => {
                    const delta = prediction.impact.deltaSeconds;
                    if (Math.abs(delta) < 0.5) {
                      return (
                        <span className="text-xs font-semibold text-textSecondary">
                          No change
                        </span>
                      );
                    }
                    // Negative delta = prediction got FASTER with this run.
                    return delta < 0 ? (
                      <span className="text-sm font-semibold text-success tabular-nums">
                        ▼ {deltaSecondsLabel(Math.abs(delta))}
                      </span>
                    ) : (
                      <span className="text-sm font-semibold text-danger tabular-nums">
                        ▲ {deltaSecondsLabel(delta)}
                      </span>
                    );
                  })()}
              </div>
            )}
            <span className="text-[10px] text-textSecondary">
              Prediction recomputed with this run vs. without it
            </span>
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
