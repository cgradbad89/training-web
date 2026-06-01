"use client";

import React, { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { type RunningGoal, type GoalMetric } from "@/types/goal";
import { type HealthWorkout } from "@/types/healthWorkout";
import { createGoal, updateGoal, softDeleteGoal } from "@/services/goals";
import {
  computeGoalProgress,
  type GoalProgress,
  type GoalStatus,
} from "@/utils/goalProgress";
import { formatMiles, formatDuration } from "@/utils/pace";

// ─── Helpers ──────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function plusDaysISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** "May 1 – Jun 30, 2026" */
function formatGoalRange(startStr: string, endStr: string): string {
  const start = parseLocal(startStr);
  const end = parseLocal(endStr);
  const s = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const e = end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${s} – ${e}`;
}

const METRIC_LABEL: Record<GoalMetric, string> = {
  distance: "Distance",
  time: "Time",
  count: "Run count",
};

const METRIC_BADGE_CLASS: Record<GoalMetric, string> = {
  // Matches the pill shape of RunTypeBadge (plans page), token colors only.
  distance: "bg-primary/10 text-primary",
  time: "bg-warning/15 text-warning",
  count: "bg-success/10 text-success",
};

const METRIC_UNIT: Record<GoalMetric, string> = {
  distance: "miles",
  time: "hours",
  count: "runs",
};

/** Format "actual / target" using existing formatters. */
function formatActualTarget(metric: GoalMetric, p: GoalProgress): string {
  if (metric === "distance") {
    return `${formatMiles(p.actual)} / ${formatMiles(p.target)} mi`;
  }
  if (metric === "time") {
    return `${formatDuration(p.actual)} / ${formatDuration(p.target)}`;
  }
  return `${p.actual} / ${p.target} runs`;
}

function ringColor(
  metric: GoalMetric,
  status: GoalStatus,
  met: boolean
): string {
  if (status === "upcoming") return "var(--color-border)";
  if (status === "completed")
    return met ? "var(--color-chart-success)" : "var(--color-chart-hr)";
  // active
  if (metric === "distance") return "var(--color-chart-pace)";
  if (metric === "time") return "var(--color-chart-warning)";
  return "var(--color-chart-success)"; // count
}

// ─── Progress ring ──────────────────────────────────────────────────────────

function ProgressRing({
  percent,
  color,
  outlineOnly,
}: {
  percent: number;
  color: string;
  outlineOnly: boolean;
}) {
  const size = 64;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(percent / 100, 1));
  const offset = circumference * (1 - frac);

  return (
    <svg width={size} height={size} className="shrink-0">
      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={stroke}
      />
      {/* Progress arc */}
      {!outlineOnly && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-textSecondary"
        style={{ fontSize: 12, fontWeight: 600 }}
      >
        {outlineOnly ? "—" : `${Math.round(percent)}%`}
      </text>
    </svg>
  );
}

// ─── Goal card ────────────────────────────────────────────────────────────

function GoalCard({
  goal,
  progress,
  onEdit,
  onDelete,
}: {
  goal: RunningGoal;
  progress: GoalProgress;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const met = progress.percent >= 100;
  const greyed = progress.status === "completed";
  const color = ringColor(goal.metric, progress.status, met);

  return (
    <div
      className={`bg-card rounded-2xl border border-border p-4 ${
        greyed ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <ProgressRing
          percent={progress.percent}
          color={color}
          outlineOnly={progress.status === "upcoming"}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4
                  className={`text-sm font-semibold truncate ${
                    greyed ? "text-textSecondary" : "text-textPrimary"
                  }`}
                >
                  {goal.label}
                </h4>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${METRIC_BADGE_CLASS[goal.metric]}`}
                >
                  {METRIC_LABEL[goal.metric]}
                </span>
              </div>
              <p className="text-xs text-textSecondary mt-0.5">
                {formatGoalRange(goal.startDate, goal.endDate)}
              </p>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={onEdit}
                title="Edit goal"
                className="p-1.5 rounded-lg text-textSecondary hover:text-textPrimary hover:bg-surface"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onDelete}
                title="Delete goal"
                className="p-1.5 rounded-lg text-textSecondary hover:text-danger hover:bg-surface"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Actual / target */}
          <p
            className={`text-sm mt-2 tabular-nums ${
              greyed ? "text-textSecondary" : "text-textPrimary"
            }`}
          >
            {formatActualTarget(goal.metric, progress)}
          </p>

          {/* Pace status (active) or met/missed (completed) */}
          {progress.status === "active" && (
            <p
              className="text-xs mt-1 font-medium"
              style={{
                color:
                  progress.paceStatus === "ahead"
                    ? "var(--color-chart-success)"
                    : progress.paceStatus === "behind"
                      ? "var(--color-chart-hr)"
                      : "var(--color-textSecondary)",
              }}
            >
              {progress.paceStatus === "ahead"
                ? "ahead of pace"
                : progress.paceStatus === "behind"
                  ? "behind pace"
                  : "on track"}
            </p>
          )}
          {progress.status === "completed" && (
            <span
              className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full mt-1.5 ${
                met
                  ? "bg-success/10 text-success"
                  : "bg-danger/10 text-danger"
              }`}
            >
              {met ? "Met" : "Missed"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Goal form (modal) ───────────────────────────────────────────────────────

interface FormState {
  id: string | null;
  label: string;
  metric: GoalMetric;
  target: string;
  startDate: string;
  endDate: string;
}

function emptyForm(): FormState {
  return {
    id: null,
    label: "",
    metric: "distance",
    target: "",
    startDate: todayISO(),
    endDate: plusDaysISO(30),
  };
}

function GoalFormModal({
  initial,
  saving,
  error,
  onClose,
  onSave,
}: {
  initial: FormState;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (f: FormState) => void;
}) {
  const [form, setForm] = useState<FormState>(initial);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-card rounded-2xl shadow-xl w-full max-w-sm max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <button onClick={onClose} className="text-sm text-textSecondary">
            Cancel
          </button>
          <h3 className="text-sm font-semibold text-textPrimary">
            {form.id ? "Edit Goal" : "New Goal"}
          </h3>
          <button
            onClick={() => onSave(form)}
            disabled={saving}
            className="text-sm font-semibold text-primary disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-3">
          {/* Label */}
          <div>
            <label className="text-sm font-medium text-textPrimary block mb-1">
              Label <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="e.g. June base miles"
              className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
          </div>

          {/* Metric segmented toggle */}
          <div>
            <label className="text-sm font-medium text-textPrimary block mb-1">
              Metric
            </label>
            <div className="flex gap-2">
              {(["distance", "time", "count"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setForm({ ...form, metric: m })}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    form.metric === m
                      ? "bg-primary text-white"
                      : "border border-border text-textSecondary hover:text-textPrimary"
                  }`}
                >
                  {METRIC_LABEL[m]}
                </button>
              ))}
            </div>
          </div>

          {/* Target */}
          <div>
            <label className="text-sm font-medium text-textPrimary block mb-1">
              Target <span className="text-danger">*</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="any"
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
                className="flex-1 border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <span className="text-sm text-textSecondary w-12">
                {METRIC_UNIT[form.metric]}
              </span>
            </div>
          </div>

          {/* Dates */}
          <div>
            <label className="text-sm font-medium text-textPrimary block mb-1">
              Start Date <span className="text-danger">*</span>
            </label>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-textPrimary block mb-1">
              End Date <span className="text-danger">*</span>
            </label>
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-2">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ─── Goals Tab ────────────────────────────────────────────────────────────

interface GoalsTabProps {
  uid: string | null;
  goals: RunningGoal[];
  loading: boolean;
  runs: HealthWorkout[];
  onChanged: () => void;
}

export function GoalsTab({ uid, goals, loading, runs, onChanged }: GoalsTabProps) {
  const [formInitial, setFormInitial] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();

  // Live goals only (soft-deleted goals have isActive === false).
  const live = goals.filter((g) => g.isActive !== false);
  const withProgress = live.map((goal) => ({
    goal,
    progress: computeGoalProgress(goal, runs, today),
  }));

  const active = withProgress.filter((g) => g.progress.status === "active");
  const upcoming = withProgress.filter((g) => g.progress.status === "upcoming");
  const completed = withProgress.filter((g) => g.progress.status === "completed");

  function openCreate() {
    setError(null);
    setFormInitial(emptyForm());
  }

  function openEdit(goal: RunningGoal) {
    setError(null);
    setFormInitial({
      id: goal.id,
      label: goal.label,
      metric: goal.metric,
      target:
        goal.metric === "time"
          ? String(goal.target / 3600)
          : String(goal.target),
      startDate: goal.startDate,
      endDate: goal.endDate,
    });
  }

  async function handleSave(f: FormState) {
    if (!uid) return;
    const label = f.label.trim();
    const targetNum = Number(f.target);
    if (!label) {
      setError("Label is required.");
      return;
    }
    if (!Number.isFinite(targetNum) || targetNum <= 0) {
      setError("Target must be greater than 0.");
      return;
    }
    if (f.endDate < f.startDate) {
      setError("End date must be on or after the start date.");
      return;
    }
    const targetStored = f.metric === "time" ? targetNum * 3600 : targetNum;

    setSaving(true);
    setError(null);
    try {
      if (f.id) {
        await updateGoal(uid, f.id, {
          label,
          metric: f.metric,
          target: targetStored,
          startDate: f.startDate,
          endDate: f.endDate,
        });
      } else {
        await createGoal(uid, {
          label,
          metric: f.metric,
          target: targetStored,
          startDate: f.startDate,
          endDate: f.endDate,
          isActive: true,
        });
      }
      setFormInitial(null);
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save goal. Please try again."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(goalId: string) {
    if (!uid) return;
    try {
      await softDeleteGoal(uid, goalId);
      onChanged();
    } catch (e) {
      console.error("[GoalsTab] soft delete failed", e);
    }
  }

  const isEmpty = !loading && live.length === 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-textPrimary">Goals</h2>
          <button
            onClick={openCreate}
            disabled={!uid}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            New goal
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : isEmpty ? (
          <p className="text-sm text-textSecondary text-center py-10">
            No goals yet — create your first goal below.
          </p>
        ) : (
          <div className="space-y-6">
            {active.length > 0 && (
              <Section title="Active">
                {active.map(({ goal, progress }) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    progress={progress}
                    onEdit={() => openEdit(goal)}
                    onDelete={() => handleDelete(goal.id)}
                  />
                ))}
              </Section>
            )}
            {upcoming.length > 0 && (
              <Section title="Upcoming">
                {upcoming.map(({ goal, progress }) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    progress={progress}
                    onEdit={() => openEdit(goal)}
                    onDelete={() => handleDelete(goal.id)}
                  />
                ))}
              </Section>
            )}
            {completed.length > 0 && (
              <Section title="Completed">
                {completed.map(({ goal, progress }) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    progress={progress}
                    onEdit={() => openEdit(goal)}
                    onDelete={() => handleDelete(goal.id)}
                  />
                ))}
              </Section>
            )}
          </div>
        )}
      </div>

      {formInitial && (
        <GoalFormModal
          key={formInitial.id ?? "new"}
          initial={formInitial}
          saving={saving}
          error={error}
          onClose={() => setFormInitial(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
