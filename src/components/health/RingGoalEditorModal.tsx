"use client";

import React, { useEffect, useMemo, useState } from "react";
import { X, ChevronRight } from "lucide-react";
import { saveHealthGoals } from "@/services/healthGoals";
import {
  DEFAULT_GOALS,
  RING_METRICS,
  toIsoDate,
} from "@/lib/ringMath";
import type {
  DayOfWeekGoals,
  HealthGoalDoc,
  RingMetric,
} from "@/types/healthGoal";

// Monday-start display order (app convention, src/utils/dates.ts).
const DAY_KEYS: readonly (keyof DayOfWeekGoals)[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];
const DAY_LABELS: Record<keyof DayOfWeekGoals, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const METRIC_CONFIG: Record<
  RingMetric,
  { label: string; unit: string; step: string }
> = {
  steps: { label: "Steps", unit: "steps", step: "500" },
  exercise_mins: { label: "Exercise", unit: "min", step: "5" },
  move_calories: { label: "Move", unit: "kcal", step: "25" },
  stand_hours: { label: "Stand", unit: "hr", step: "1" },
  sleep_total_hours: { label: "Sleep", unit: "h", step: "0.5" },
};

interface MetricFormState {
  /** false = one "same every day" input; true = 7 per-day inputs. */
  perDayMode: boolean;
  same: string;
  perDay: Record<keyof DayOfWeekGoals, string>;
}

type FormState = Record<RingMetric, MetricFormState>;

/** The goal version active today (latest effectiveFrom <= today, createdAt ties). */
function activeDocForToday(goals: HealthGoalDoc[]): HealthGoalDoc | null {
  const today = toIsoDate(new Date());
  let active: HealthGoalDoc | null = null;
  for (const g of goals) {
    if (g.effectiveFrom > today) continue;
    if (
      active === null ||
      g.effectiveFrom > active.effectiveFrom ||
      (g.effectiveFrom === active.effectiveFrom &&
        g.createdAt > active.createdAt)
    ) {
      active = g;
    }
  }
  return active;
}

function buildInitialForm(goals: HealthGoalDoc[]): FormState {
  const active = activeDocForToday(goals);
  const form = {} as FormState;
  for (const metric of RING_METRICS) {
    const week = active?.metrics?.[metric];
    if (week) {
      const values = DAY_KEYS.map((k) =>
        typeof week[k] === "number" ? week[k] : DEFAULT_GOALS[metric]
      );
      const allSame = values.every((v) => v === values[0]);
      form[metric] = {
        perDayMode: !allSame,
        same: String(values[0]),
        perDay: Object.fromEntries(
          DAY_KEYS.map((k, i) => [k, String(values[i])])
        ) as Record<keyof DayOfWeekGoals, string>,
      };
    } else {
      const def = String(DEFAULT_GOALS[metric]);
      form[metric] = {
        perDayMode: false,
        same: def,
        perDay: Object.fromEntries(DAY_KEYS.map((k) => [k, def])) as Record<
          keyof DayOfWeekGoals,
          string
        >,
      };
    }
  }
  return form;
}

/** Parse one input; blank/invalid/negative falls back to the metric default. */
function parseGoalInput(raw: string, metric: RingMetric): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GOALS[metric];
  return n;
}

function buildGoalDoc(form: FormState): HealthGoalDoc {
  const metrics = {} as HealthGoalDoc["metrics"];
  for (const metric of RING_METRICS) {
    const f = form[metric];
    const week = {} as DayOfWeekGoals;
    for (const k of DAY_KEYS) {
      week[k] = f.perDayMode
        ? parseGoalInput(f.perDay[k], metric)
        : parseGoalInput(f.same, metric);
    }
    metrics[metric] = week;
  }
  return {
    effectiveFrom: toIsoDate(new Date()),
    createdAt: Date.now(),
    metrics,
  };
}

export interface RingGoalEditorModalProps {
  isOpen: boolean;
  uid: string;
  /** All goal versions (used to pre-fill from the currently-active one). */
  goals: HealthGoalDoc[];
  onClose: () => void;
  /** Called after a successful save with the newly created version. */
  onSaved: (doc: HealthGoalDoc) => void;
}

/**
 * Editor for the effective-dated ring goals (users/{uid}/healthGoals).
 * Saving always appends a NEW version with effectiveFrom = today — past days
 * keep scoring against the version active on those days.
 */
export function RingGoalEditorModal({
  isOpen,
  uid,
  goals,
  onClose,
  onSaved,
}: RingGoalEditorModalProps) {
  const initialForm = useMemo(() => buildInitialForm(goals), [goals]);
  const [form, setForm] = useState<FormState>(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-prefill whenever the modal is (re-)opened with fresh goal versions.
  useEffect(() => {
    if (isOpen) {
      setForm(buildInitialForm(goals));
      setError(null);
    }
  }, [isOpen, goals]);

  // ESC + scroll lock — same pattern as HealthGoalsModal.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function setMetric(metric: RingMetric, patch: Partial<MetricFormState>) {
    setForm((prev) => ({ ...prev, [metric]: { ...prev[metric], ...patch } }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const docToSave = buildGoalDoc(form);
      await saveHealthGoals(uid, docToSave);
      onSaved(docToSave);
      onClose();
    } catch (err) {
      console.error("[RingGoalEditorModal] save failed:", err);
      setError("Could not save goals. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ring-goals-title"
    >
      <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border bg-card z-10">
          <div>
            <h2
              id="ring-goals-title"
              className="text-base font-semibold text-textPrimary"
            >
              Ring Goals
            </h2>
            <p className="text-[11px] text-textSecondary mt-0.5">
              Saved changes apply from today onward — past days keep their
              old goals.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 rounded-lg text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-5">
          {RING_METRICS.map((metric) => {
            const cfg = METRIC_CONFIG[metric];
            const f = form[metric];
            return (
              <div key={metric}>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-textSecondary">
                    {cfg.label}{" "}
                    <span className="normal-case font-normal">
                      ({cfg.unit}/day)
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setMetric(metric, { perDayMode: !f.perDayMode })
                    }
                    className="flex items-center gap-1 text-xs text-textSecondary hover:text-textPrimary transition-colors"
                    aria-expanded={f.perDayMode}
                  >
                    <ChevronRight
                      className={`w-3 h-3 transition-transform ${
                        f.perDayMode ? "rotate-90" : ""
                      }`}
                    />
                    Per-day
                  </button>
                </div>

                {!f.perDayMode ? (
                  <label className="flex items-center gap-2 text-sm text-textSecondary">
                    <span className="text-xs w-24">Every day:</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step={cfg.step}
                      value={f.same}
                      onChange={(e) =>
                        setMetric(metric, { same: e.target.value })
                      }
                      className="w-28 px-2 py-1.5 text-sm rounded-lg border border-border bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </label>
                ) : (
                  <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                    {DAY_KEYS.map((k) => (
                      <label key={k} className="flex flex-col gap-0.5">
                        <span className="text-[10px] text-textSecondary text-center">
                          {DAY_LABELS[k]}
                        </span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step={cfg.step}
                          value={f.perDay[k]}
                          onChange={(e) =>
                            setMetric(metric, {
                              perDay: { ...f.perDay, [k]: e.target.value },
                            })
                          }
                          className="w-full px-1 py-1 text-xs rounded-lg border border-border bg-card text-textPrimary text-center focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded-xl text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-semibold rounded-xl bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Goals"}
          </button>
        </div>
      </div>
    </div>
  );
}
