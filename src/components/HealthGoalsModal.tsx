"use client";

import React, { useEffect, useState, useCallback } from "react";
import { ChevronRight, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  saveHealthGoals,
  clearHealthGoals,
  type HealthGoals,
  type MetricGoal,
  type WeightGoal,
  type BMIGoal,
} from "@/services/healthMetrics";

const DEFAULT_WARNING_PCT = 5;
const DEFAULT_DANGER_PCT = 15;

// ── Form state ──────────────────────────────────────────────────────────────
//
// Inputs live as strings so the user can clear/retype freely; we only convert
// on save. An empty string in the primary field means "no goal for this
// metric."

interface FormState {
  // Weight
  weightGoal: string;
  weightTolerance: string;
  weightWarningPct: string;
  weightDangerPct: string;
  // BMI
  bmiMin: string;
  bmiMax: string;
  bmiWarningPct: string;
  bmiDangerPct: string;
  // Resting HR
  restingHRGoal: string;
  restingHRWarningPct: string;
  restingHRDangerPct: string;
  // Steps
  stepsGoal: string;
  stepsWarningPct: string;
  stepsDangerPct: string;
  // Sleep
  sleepGoal: string;
  sleepWarningPct: string;
  sleepDangerPct: string;
  // Brushing
  brushingGoal: string;
  brushingWarningPct: string;
  brushingDangerPct: string;
}

function emptyForm(): FormState {
  return {
    weightGoal: "", weightTolerance: "", weightWarningPct: "", weightDangerPct: "",
    bmiMin: "", bmiMax: "", bmiWarningPct: "", bmiDangerPct: "",
    restingHRGoal: "", restingHRWarningPct: "", restingHRDangerPct: "",
    stepsGoal: "", stepsWarningPct: "", stepsDangerPct: "",
    sleepGoal: "", sleepWarningPct: "", sleepDangerPct: "",
    brushingGoal: "", brushingWarningPct: "", brushingDangerPct: "",
  };
}

function formFromGoals(goals: HealthGoals | null): FormState {
  const f = emptyForm();
  if (!goals) return f;
  if (goals.weight) {
    f.weightGoal       = String(goals.weight.goal);
    f.weightTolerance  = String(goals.weight.tolerance);
    f.weightWarningPct = goals.weight.warningPct != null ? String(goals.weight.warningPct) : "";
    f.weightDangerPct  = goals.weight.dangerPct  != null ? String(goals.weight.dangerPct)  : "";
  }
  if (goals.bmi) {
    f.bmiMin        = String(goals.bmi.min);
    f.bmiMax        = String(goals.bmi.max);
    f.bmiWarningPct = goals.bmi.warningPct != null ? String(goals.bmi.warningPct) : "";
    f.bmiDangerPct  = goals.bmi.dangerPct  != null ? String(goals.bmi.dangerPct)  : "";
  }
  if (goals.restingHR) {
    f.restingHRGoal       = String(goals.restingHR.goal);
    f.restingHRWarningPct = goals.restingHR.warningPct != null ? String(goals.restingHR.warningPct) : "";
    f.restingHRDangerPct  = goals.restingHR.dangerPct  != null ? String(goals.restingHR.dangerPct)  : "";
  }
  if (goals.steps) {
    f.stepsGoal       = String(goals.steps.goal);
    f.stepsWarningPct = goals.steps.warningPct != null ? String(goals.steps.warningPct) : "";
    f.stepsDangerPct  = goals.steps.dangerPct  != null ? String(goals.steps.dangerPct)  : "";
  }
  if (goals.sleep) {
    f.sleepGoal       = String(goals.sleep.goal);
    f.sleepWarningPct = goals.sleep.warningPct != null ? String(goals.sleep.warningPct) : "";
    f.sleepDangerPct  = goals.sleep.dangerPct  != null ? String(goals.sleep.dangerPct)  : "";
  }
  if (goals.brushing) {
    f.brushingGoal       = String(goals.brushing.goal);
    f.brushingWarningPct = goals.brushing.warningPct != null ? String(goals.brushing.warningPct) : "";
    f.brushingDangerPct  = goals.brushing.dangerPct  != null ? String(goals.brushing.dangerPct)  : "";
  }
  return f;
}

function parseNum(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return isFinite(n) ? n : undefined;
}

function buildGoalsFromForm(f: FormState): HealthGoals {
  const goals: HealthGoals = {};

  const wg = parseNum(f.weightGoal);
  const wt = parseNum(f.weightTolerance);
  if (wg != null && wt != null) {
    const out: WeightGoal = { goal: wg, tolerance: wt };
    const wp = parseNum(f.weightWarningPct);
    const dp = parseNum(f.weightDangerPct);
    if (wp != null) out.warningPct = wp;
    if (dp != null) out.dangerPct  = dp;
    goals.weight = out;
  }

  const bMin = parseNum(f.bmiMin);
  const bMax = parseNum(f.bmiMax);
  if (bMin != null && bMax != null) {
    const out: BMIGoal = { min: bMin, max: bMax };
    const wp = parseNum(f.bmiWarningPct);
    const dp = parseNum(f.bmiDangerPct);
    if (wp != null) out.warningPct = wp;
    if (dp != null) out.dangerPct  = dp;
    goals.bmi = out;
  }

  function single(g: string, wPct: string, dPct: string): MetricGoal | undefined {
    const goalN = parseNum(g);
    if (goalN == null) return undefined;
    const out: MetricGoal = { goal: goalN };
    const wp = parseNum(wPct);
    const dp = parseNum(dPct);
    if (wp != null) out.warningPct = wp;
    if (dp != null) out.dangerPct  = dp;
    return out;
  }

  const rhr  = single(f.restingHRGoal, f.restingHRWarningPct, f.restingHRDangerPct);
  if (rhr) goals.restingHR = rhr;
  const stp  = single(f.stepsGoal, f.stepsWarningPct, f.stepsDangerPct);
  if (stp) goals.steps = stp;
  const slp  = single(f.sleepGoal, f.sleepWarningPct, f.sleepDangerPct);
  if (slp) goals.sleep = slp;
  const brh  = single(f.brushingGoal, f.brushingWarningPct, f.brushingDangerPct);
  if (brh) goals.brushing = brh;

  return goals;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function NumberField({
  value,
  onChange,
  placeholder,
  step,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  step?: string;
  className?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step={step}
      className={`w-20 px-2 py-1.5 text-sm rounded-lg border border-border bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary ${className}`}
    />
  );
}

function AdvancedThresholds({
  warningValue,
  dangerValue,
  onWarningChange,
  onDangerChange,
  warningLabel = "Warning if",
  dangerLabel = "Danger if",
  shown,
}: {
  warningValue: string;
  dangerValue: string;
  onWarningChange: (v: string) => void;
  onDangerChange: (v: string) => void;
  warningLabel?: string;
  dangerLabel?: string;
  shown: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!shown) return null;

  const wDisp = warningValue || String(DEFAULT_WARNING_PCT);
  const dDisp = dangerValue  || String(DEFAULT_DANGER_PCT);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-textSecondary hover:text-textPrimary"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
        Advanced thresholds
        {!open && (
          <span className="text-textSecondary/80">
            (Warning &gt;{wDisp}%, Danger &gt;{dDisp}%)
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 ml-4 flex flex-col gap-1.5 text-xs text-textSecondary">
          <label className="flex items-center gap-2">
            <span className="w-24">{warningLabel}:</span>
            <NumberField
              value={warningValue}
              onChange={onWarningChange}
              placeholder={String(DEFAULT_WARNING_PCT)}
            />
            <span>%</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24">{dangerLabel}:</span>
            <NumberField
              value={dangerValue}
              onChange={onDangerChange}
              placeholder={String(DEFAULT_DANGER_PCT)}
            />
            <span>%</span>
          </label>
        </div>
      )}
    </div>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-widest text-textSecondary border-b border-border pb-1 mt-5 first:mt-0">
      {children}
    </h3>
  );
}

// ── Main modal ───────────────────────────────────────────────────────────────

export interface HealthGoalsModalProps {
  isOpen: boolean;
  uid: string;
  initialGoals: HealthGoals | null;
  onClose: () => void;
  /** Called after a successful save with the new goals object. */
  onSaved: (goals: HealthGoals) => void;
  /** Called after a successful clear. */
  onCleared: () => void;
}

export function HealthGoalsModal({
  isOpen,
  uid,
  initialGoals,
  onClose,
  onSaved,
  onCleared,
}: HealthGoalsModalProps) {
  const [form, setForm] = useState<FormState>(() => formFromGoals(initialGoals));
  const [saving, setSaving] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Reset form when the modal is (re-)opened with different initial goals.
  useEffect(() => {
    if (isOpen) setForm(formFromGoals(initialGoals));
  }, [isOpen, initialGoals]);

  // ESC + scroll lock — hook called unconditionally.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !confirmingClear) onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose, confirmingClear]);

  const setField = useCallback(
    (key: keyof FormState) => (v: string) =>
      setForm((prev) => ({ ...prev, [key]: v })),
    []
  );

  // Live previews ─────────────────────────────────────────────────────────────
  const weightLow =
    parseNum(form.weightGoal) != null && parseNum(form.weightTolerance) != null
      ? (parseNum(form.weightGoal) ?? 0) - (parseNum(form.weightTolerance) ?? 0)
      : null;
  const weightHigh =
    parseNum(form.weightGoal) != null && parseNum(form.weightTolerance) != null
      ? (parseNum(form.weightGoal) ?? 0) + (parseNum(form.weightTolerance) ?? 0)
      : null;

  if (!isOpen) return null;

  async function handleSave() {
    setSaving(true);
    try {
      const goals = buildGoalsFromForm(form);
      await saveHealthGoals(uid, goals);
      onSaved(goals);
      onClose();
    } catch (err) {
      console.error("[HealthGoalsModal] save failed:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmClear() {
    setSaving(true);
    try {
      await clearHealthGoals(uid);
      onCleared();
      setConfirmingClear(false);
      onClose();
    } catch (err) {
      console.error("[HealthGoalsModal] clear failed:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget && !saving) onClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="health-goals-title"
      >
        <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-md max-h-[90vh] flex flex-col">
          {/* Sticky header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border sticky top-0 bg-card z-10">
            <h2
              id="health-goals-title"
              className="text-base font-semibold text-textPrimary"
            >
              Health Goals
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 -mr-2 flex items-center justify-center text-textSecondary hover:text-textPrimary rounded-lg"
            >
              <X size={18} />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* BODY */}
            <GroupHeading>Body</GroupHeading>

            <div className="mt-3">
              <p className="text-sm font-medium text-textPrimary mb-1">Weight</p>
              <div className="flex items-center gap-2 text-sm text-textSecondary">
                Target
                <NumberField
                  value={form.weightGoal}
                  onChange={setField("weightGoal")}
                  step="0.1"
                  placeholder="173"
                />
                lbs ±
                <NumberField
                  value={form.weightTolerance}
                  onChange={setField("weightTolerance")}
                  step="0.1"
                  placeholder="3"
                />
                lbs
              </div>
              {weightLow != null && weightHigh != null && (
                <p className="text-xs text-textSecondary mt-1">
                  Success range: {weightLow.toFixed(1)}–{weightHigh.toFixed(1)} lbs
                </p>
              )}
              <AdvancedThresholds
                shown={parseNum(form.weightGoal) != null}
                warningValue={form.weightWarningPct}
                dangerValue={form.weightDangerPct}
                onWarningChange={setField("weightWarningPct")}
                onDangerChange={setField("weightDangerPct")}
                warningLabel="Warning if"
                dangerLabel="Danger if"
              />
            </div>

            <div className="mt-5">
              <p className="text-sm font-medium text-textPrimary mb-1">BMI Range</p>
              <div className="flex items-center gap-2 text-sm text-textSecondary">
                Min
                <NumberField
                  value={form.bmiMin}
                  onChange={setField("bmiMin")}
                  step="0.1"
                  placeholder="18.5"
                />
                Max
                <NumberField
                  value={form.bmiMax}
                  onChange={setField("bmiMax")}
                  step="0.1"
                  placeholder="24.9"
                />
              </div>
              <AdvancedThresholds
                shown={
                  parseNum(form.bmiMin) != null && parseNum(form.bmiMax) != null
                }
                warningValue={form.bmiWarningPct}
                dangerValue={form.bmiDangerPct}
                onWarningChange={setField("bmiWarningPct")}
                onDangerChange={setField("bmiDangerPct")}
              />
            </div>

            {/* HEART */}
            <GroupHeading>Heart</GroupHeading>

            <div className="mt-3">
              <p className="text-sm font-medium text-textPrimary mb-1">
                Resting Heart Rate
              </p>
              <div className="flex items-center gap-2 text-sm text-textSecondary">
                Goal
                <NumberField
                  value={form.restingHRGoal}
                  onChange={setField("restingHRGoal")}
                  placeholder="65"
                />
                bpm or below
              </div>
              <AdvancedThresholds
                shown={parseNum(form.restingHRGoal) != null}
                warningValue={form.restingHRWarningPct}
                dangerValue={form.restingHRDangerPct}
                onWarningChange={setField("restingHRWarningPct")}
                onDangerChange={setField("restingHRDangerPct")}
                warningLabel="Warning if above"
                dangerLabel="Danger if above"
              />
            </div>

            {/* ACTIVITY */}
            <GroupHeading>Activity</GroupHeading>

            <div className="mt-3">
              <p className="text-sm font-medium text-textPrimary mb-1">Daily Steps</p>
              <div className="flex items-center gap-2 text-sm text-textSecondary">
                Goal
                <NumberField
                  value={form.stepsGoal}
                  onChange={setField("stepsGoal")}
                  placeholder="8000"
                  className="w-24"
                />
                steps or above
              </div>
              <AdvancedThresholds
                shown={parseNum(form.stepsGoal) != null}
                warningValue={form.stepsWarningPct}
                dangerValue={form.stepsDangerPct}
                onWarningChange={setField("stepsWarningPct")}
                onDangerChange={setField("stepsDangerPct")}
                warningLabel="Warning if below"
                dangerLabel="Danger if below"
              />
            </div>

            {/* RECOVERY */}
            <GroupHeading>Recovery</GroupHeading>

            <div className="mt-3">
              <p className="text-sm font-medium text-textPrimary mb-1">Sleep</p>
              <div className="flex items-center gap-2 text-sm text-textSecondary">
                Goal
                <NumberField
                  value={form.sleepGoal}
                  onChange={setField("sleepGoal")}
                  step="0.1"
                  placeholder="7.5"
                />
                hours or above
              </div>
              <AdvancedThresholds
                shown={parseNum(form.sleepGoal) != null}
                warningValue={form.sleepWarningPct}
                dangerValue={form.sleepDangerPct}
                onWarningChange={setField("sleepWarningPct")}
                onDangerChange={setField("sleepDangerPct")}
                warningLabel="Warning if below"
                dangerLabel="Danger if below"
              />
            </div>

            <div className="mt-5">
              <p className="text-sm font-medium text-textPrimary mb-1">Brushing</p>
              <div className="flex items-center gap-2 text-sm text-textSecondary">
                Goal
                <NumberField
                  value={form.brushingGoal}
                  onChange={setField("brushingGoal")}
                  step="0.1"
                  placeholder="2"
                />
                sessions/day or above
              </div>
              <AdvancedThresholds
                shown={parseNum(form.brushingGoal) != null}
                warningValue={form.brushingWarningPct}
                dangerValue={form.brushingDangerPct}
                onWarningChange={setField("brushingWarningPct")}
                onDangerChange={setField("brushingDangerPct")}
                warningLabel="Warning if below"
                dangerLabel="Danger if below"
              />
            </div>
          </div>

          {/* Sticky footer */}
          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-card">
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              disabled={saving}
              className="text-sm text-danger hover:opacity-80 disabled:opacity-50"
            >
              Clear All Goals
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-xl border border-border text-textSecondary hover:bg-surface disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm rounded-xl bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Goals"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmingClear}
        title="Clear all health goals?"
        message="This removes every metric goal and disables the goal-driven coloring on the Health page. You can set new goals at any time."
        confirmLabel="Clear All"
        confirmVariant="danger"
        onConfirm={handleConfirmClear}
        onCancel={() => setConfirmingClear(false)}
        loading={saving}
      />
    </>
  );
}
