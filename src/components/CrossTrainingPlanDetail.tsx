"use client";

/**
 * Cross-training plan detail view (Workout + Pilates plans).
 *
 * Renders inline for the selected plan on the Plans page. Handles both:
 *   - Workout plans (planType: "workout") — exercise list per day
 *   - Pilates plans (planType: "pilates") — duration + label per day
 *
 * All edits are saved through the parent's onUpdate callback so persistence
 * stays centralized in the Plans page.
 */

import React, { useState, useMemo } from "react";
import {
  Pencil,
  Trash2,
  Plus,
  X,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import {
  type WorkoutPlan,
  type PilatesPlan,
  type PlannedWorkoutEntry,
  type PlannedPilatesEntry,
  type PlanExercise,
  type PlanWorkoutWeek,
  type PlanPilatesWeek,
  isWorkoutPlan,
} from "@/types/plan";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const DAY_ABBREVS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// ─── Date helpers ───────────────────────────────────────────────────────────

function dayDate(startDate: string, weekIndex: number, weekday: number): Date {
  const [year, month, day] = startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const offset = weekIndex * 7 + (weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + offset);
  return d;
}

function weekDateRange(startDate: string, weekIdx: number): string {
  const start = new Date(startDate + "T00:00:00");
  start.setDate(start.getDate() + weekIdx * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

// ─── Workout entry editor ──────────────────────────────────────────────────

interface WorkoutEntryEditorProps {
  entry: PlannedWorkoutEntry;
  onSave: (entry: PlannedWorkoutEntry) => void;
  onCancel: () => void;
}

function WorkoutEntryEditor({
  entry,
  onSave,
  onCancel,
}: WorkoutEntryEditorProps) {
  const [label, setLabel] = useState(entry.label ?? "");
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [exercises, setExercises] = useState<PlanExercise[]>(
    entry.exercises ?? []
  );

  function addExercise() {
    setExercises((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: "",
        sets: 3,
        reps: 10,
        weight_lbs: 0,
      },
    ]);
  }

  function updateExercise(id: string, patch: Partial<PlanExercise>) {
    setExercises((prev) =>
      prev.map((ex) => (ex.id === id ? { ...ex, ...patch } : ex))
    );
  }

  function removeExercise(id: string) {
    setExercises((prev) => prev.filter((ex) => ex.id !== id));
  }

  function handleSave() {
    onSave({
      ...entry,
      type: "workout",
      label: label.trim() || undefined,
      notes: notes.trim() || undefined,
      exercises: exercises.filter((ex) => ex.name.trim().length > 0),
    });
  }

  return (
    <div className="bg-surface rounded-xl p-4 mx-3 mb-2 border border-border">
      <div className="grid grid-cols-1 gap-2 mb-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Upper Body)"
          className="w-full text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          autoFocus
        />
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 200))}
          placeholder="Notes (optional)"
          className="w-full text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
        />
      </div>

      {/* Exercises list */}
      <div className="flex flex-col gap-2 mb-3">
        {exercises.length === 0 && (
          <p className="text-xs text-textSecondary italic">No exercises yet</p>
        )}
        {exercises.map((ex) => (
          <div key={ex.id} className="flex items-center gap-1.5">
            <input
              type="text"
              value={ex.name}
              onChange={(e) => updateExercise(ex.id, { name: e.target.value })}
              placeholder="Exercise"
              className="flex-1 min-w-0 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
            />
            <input
              type="number"
              value={ex.sets}
              min={0}
              onChange={(e) =>
                updateExercise(ex.id, { sets: parseInt(e.target.value, 10) || 0 })
              }
              className="w-12 text-sm border border-border rounded-lg px-1 py-1.5 bg-card text-textPrimary text-center"
              title="Sets"
            />
            <span className="text-xs text-textSecondary">×</span>
            <input
              type="number"
              value={ex.reps}
              min={0}
              onChange={(e) =>
                updateExercise(ex.id, { reps: parseInt(e.target.value, 10) || 0 })
              }
              className="w-12 text-sm border border-border rounded-lg px-1 py-1.5 bg-card text-textPrimary text-center"
              title="Reps"
            />
            <input
              type="number"
              value={ex.weight_lbs}
              min={0}
              step={2.5}
              onChange={(e) =>
                updateExercise(ex.id, {
                  weight_lbs: parseFloat(e.target.value) || 0,
                })
              }
              className="w-16 text-sm border border-border rounded-lg px-1 py-1.5 bg-card text-textPrimary text-center"
              title="Weight (lbs)"
            />
            <span className="text-xs text-textSecondary">lbs</span>
            <button
              onClick={() => removeExercise(ex.id)}
              className="p-1 rounded hover:bg-red-100 text-textSecondary hover:text-danger"
              title="Remove exercise"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <button
        onClick={addExercise}
        className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 mb-3"
      >
        <Plus className="w-3.5 h-3.5" />
        Add exercise
      </button>

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-3 py-1.5 text-xs text-textSecondary border border-border rounded-lg hover:bg-card transition-colors"
        >
          <X className="w-3 h-3" /> Cancel
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Check className="w-3 h-3" /> Save
        </button>
      </div>
    </div>
  );
}

// ─── Pilates entry editor ──────────────────────────────────────────────────

interface PilatesEntryEditorProps {
  entry: PlannedPilatesEntry;
  onSave: (entry: PlannedPilatesEntry) => void;
  onCancel: () => void;
}

function PilatesEntryEditor({
  entry,
  onSave,
  onCancel,
}: PilatesEntryEditorProps) {
  const [label, setLabel] = useState(entry.label ?? "Reformer Pilates");
  const [duration, setDuration] = useState(
    entry.duration_mins != null ? String(entry.duration_mins) : "45"
  );
  const [notes, setNotes] = useState(entry.notes ?? "");

  function handleSave() {
    const dur = parseInt(duration, 10);
    onSave({
      ...entry,
      type: "pilates",
      label: label.trim() || undefined,
      duration_mins: isNaN(dur) ? undefined : dur,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <div className="bg-surface rounded-xl p-4 mx-3 mb-2 border border-border">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Reformer Pilates)"
          className="md:col-span-2 w-full text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          autoFocus
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="Duration"
            min={0}
            className="flex-1 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
          />
          <span className="text-sm text-textSecondary shrink-0">min</span>
        </div>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 200))}
          placeholder="Notes (optional)"
          className="w-full text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
        />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-3 py-1.5 text-xs text-textSecondary border border-border rounded-lg hover:bg-card transition-colors"
        >
          <X className="w-3 h-3" /> Cancel
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Check className="w-3 h-3" /> Save
        </button>
      </div>
    </div>
  );
}

// ─── Completion helpers ─────────────────────────────────────────────────────

function formatCompletedAt(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  }) + " at " + d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── Read-only day card ────────────────────────────────────────────────────

function WorkoutDayCard({
  entry,
  onEdit,
  onDelete,
  onUnmatch,
}: {
  entry: PlannedWorkoutEntry;
  onEdit: () => void;
  onDelete: () => void;
  onUnmatch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const exCount = entry.exercises?.length ?? 0;
  const completed = entry.completed === true;
  const completedLabel = formatCompletedAt(entry.completedAt);

  return (
    <div
      className={`flex-1 border-l-4 border-purple-400 rounded-r-lg pl-3 pr-2 py-2 ${
        completed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 text-left flex items-center gap-2 flex-wrap"
        >
          <span className="text-xs font-bold uppercase tracking-wide text-purple-600">
            Workout
          </span>
          {entry.label && (
            <span className="text-sm font-semibold text-textPrimary truncate">
              {entry.label}
            </span>
          )}
          <span className="text-xs text-textSecondary">
            · {exCount} {exCount === 1 ? "exercise" : "exercises"}
          </span>
          {completed && (
            <span className="text-xs text-success font-medium">
              ✓ Completed{completedLabel ? ` · ${completedLabel}` : ""}
            </span>
          )}
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {completed && (
            <button
              onClick={onUnmatch}
              className="text-[10px] text-textSecondary hover:text-textPrimary border border-border rounded px-1.5 py-0.5"
              title="Unmatch this session"
            >
              Unmatch
            </button>
          )}
          <button
            onClick={onEdit}
            className="p-1 rounded hover:bg-surface text-textSecondary hover:text-textPrimary"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-red-100 text-textSecondary hover:text-danger"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {expanded && exCount > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 pl-1">
          {entry.exercises!.map((ex) => (
            <li
              key={ex.id}
              className="text-xs text-textSecondary tabular-nums"
            >
              <span className="text-textPrimary font-medium">{ex.name}</span>
              {" — "}
              {ex.sets} × {ex.reps}
              {ex.weight_lbs > 0 && ` @ ${ex.weight_lbs} lbs`}
            </li>
          ))}
        </ul>
      )}
      {entry.notes && (
        <p className="text-xs text-textSecondary italic mt-1">{entry.notes}</p>
      )}
    </div>
  );
}

function PilatesDayCard({
  entry,
  onEdit,
  onDelete,
  onUnmatch,
}: {
  entry: PlannedPilatesEntry;
  onEdit: () => void;
  onDelete: () => void;
  onUnmatch: () => void;
}) {
  const completed = entry.completed === true;
  const completedLabel = formatCompletedAt(entry.completedAt);

  return (
    <div
      className={`flex-1 border-l-4 border-teal-400 rounded-r-lg pl-3 pr-2 py-2 ${
        completed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wide text-teal-600">
            Pilates
          </span>
          {entry.label && (
            <span className="text-sm font-semibold text-textPrimary truncate">
              {entry.label}
            </span>
          )}
          {entry.duration_mins != null && (
            <span className="text-xs text-textSecondary">
              · {entry.duration_mins} min
            </span>
          )}
          {completed && (
            <span className="text-xs text-success font-medium">
              ✓ Completed{completedLabel ? ` · ${completedLabel}` : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {completed && (
            <button
              onClick={onUnmatch}
              className="text-[10px] text-textSecondary hover:text-textPrimary border border-border rounded px-1.5 py-0.5"
              title="Unmatch this session"
            >
              Unmatch
            </button>
          )}
          <button
            onClick={onEdit}
            className="p-1 rounded hover:bg-surface text-textSecondary hover:text-textPrimary"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-red-100 text-textSecondary hover:text-danger"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {entry.notes && (
        <p className="text-xs text-textSecondary italic mt-1">{entry.notes}</p>
      )}
    </div>
  );
}

// ─── Plan detail component ─────────────────────────────────────────────────

interface CrossTrainingPlanDetailProps {
  plan: WorkoutPlan | PilatesPlan;
  onUpdate: (plan: WorkoutPlan | PilatesPlan) => void | Promise<void>;
  onDelete: () => void;
  onSetActive: () => void;
  saving: boolean;
}

export function CrossTrainingPlanDetail({
  plan,
  onUpdate,
  onDelete,
  onSetActive,
  saving,
}: CrossTrainingPlanDetailProps) {
  const isWorkout = isWorkoutPlan(plan);
  const accentLabel = isWorkout ? "Workout Plan" : "Pilates Plan";
  const accentBadgeClass = isWorkout
    ? "bg-purple-100 text-purple-700"
    : "bg-teal-100 text-teal-700";

  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [editingDay, setEditingDay] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const week = plan.weeks[selectedWeekIndex];
  const dateRange = useMemo(
    () => weekDateRange(plan.startDate, selectedWeekIndex),
    [plan.startDate, selectedWeekIndex]
  );

  const sortedEntries = useMemo(() => {
    if (!week) return [];
    return [...week.entries].sort((a, b) => a.weekday - b.weekday);
  }, [week]);

  // ── Update helpers ─────────────────────────────────────────────────────

  function updateWeekEntries(
    nextEntries: (PlannedWorkoutEntry | PlannedPilatesEntry)[]
  ) {
    if (isWorkout) {
      const updatedWeeks: PlanWorkoutWeek[] = plan.weeks.map((w, i) =>
        i === selectedWeekIndex
          ? { ...w, entries: nextEntries as PlannedWorkoutEntry[] }
          : w
      );
      onUpdate({ ...plan, weeks: updatedWeeks });
    } else {
      const updatedWeeks: PlanPilatesWeek[] = plan.weeks.map((w, i) =>
        i === selectedWeekIndex
          ? { ...w, entries: nextEntries as PlannedPilatesEntry[] }
          : w
      );
      onUpdate({ ...plan, weeks: updatedWeeks });
    }
  }

  function saveEntry(updated: PlannedWorkoutEntry | PlannedPilatesEntry) {
    const exists = sortedEntries.find((e) => e.id === updated.id);
    const next = exists
      ? sortedEntries.map((e) => (e.id === updated.id ? updated : e))
      : [...sortedEntries, updated];
    updateWeekEntries(next.sort((a, b) => a.weekday - b.weekday));
    setEditingDay(null);
  }

  function deleteEntry(id: string) {
    updateWeekEntries(sortedEntries.filter((e) => e.id !== id));
  }

  function unmatchEntry(id: string) {
    const next = sortedEntries.map((e) => {
      if (e.id !== id) return e;
      // Strip completed flags. Use Object spread + delete to avoid undefined leaks.
      const cleared = { ...e, completed: false };
      delete cleared.completedAt;
      return cleared;
    });
    updateWeekEntries(next);
  }

  function newEntryFor(weekday: number): PlannedWorkoutEntry | PlannedPilatesEntry {
    const base = {
      id: crypto.randomUUID(),
      weekIndex: selectedWeekIndex,
      weekday,
      dayOfWeek: weekday - 1,
    };
    return isWorkout
      ? { ...base, type: "workout" as const, exercises: [] }
      : { ...base, type: "pilates" as const, duration_mins: 45 };
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-card flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-bold text-textPrimary truncate">
              {plan.name}
            </h1>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${accentBadgeClass}`}
            >
              {accentLabel}
            </span>
            {plan.isActive && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success">
                Active
              </span>
            )}
          </div>
          <p className="text-sm text-textSecondary mt-0.5">
            Starts{" "}
            {new Date(plan.startDate + "T00:00:00").toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
            {" · "}
            {plan.weeks.length} weeks
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!plan.isActive && (
            <button
              onClick={onSetActive}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              Set Active
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={saving}
            title="Delete plan"
            className="p-1.5 rounded-lg hover:bg-red-50 text-textSecondary hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
        <button
          onClick={() => setSelectedWeekIndex((i) => Math.max(0, i - 1))}
          disabled={selectedWeekIndex === 0}
          className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-center">
          <div className="text-sm font-semibold text-textPrimary">
            Week {week?.weekNumber ?? selectedWeekIndex + 1}
          </div>
          <div className="text-xs text-textSecondary">{dateRange}</div>
        </div>
        <button
          onClick={() =>
            setSelectedWeekIndex((i) => Math.min(plan.weeks.length - 1, i + 1))
          }
          disabled={selectedWeekIndex >= plan.weeks.length - 1}
          className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Week content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="rounded-xl border border-border overflow-hidden bg-card">
          {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
            const entry = sortedEntries.find((e) => e.weekday === weekday);
            const isEditing = editingDay === weekday;
            const date = dayDate(plan.startDate, selectedWeekIndex, weekday);
            const dateLabel = date.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });

            return (
              <div
                key={weekday}
                className={weekday < 7 ? "border-b border-border" : ""}
              >
                <div className="flex items-center gap-3 py-2 px-3 hover:bg-surface/50 group min-h-[52px]">
                  <div className="w-14 shrink-0">
                    <div className="text-xs font-bold text-textSecondary">
                      {DAY_ABBREVS[weekday - 1]}
                    </div>
                    <div className="text-xs text-textSecondary">
                      {dateLabel}
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-textSecondary italic">
                        {entry ? "Editing…" : "Adding session…"}
                      </span>
                    </div>
                  ) : !entry || entry.type === "rest" ? (
                    <>
                      <span className="text-sm text-textSecondary italic flex-1">
                        Rest
                      </span>
                      <button
                        onClick={() => setEditingDay(weekday)}
                        className="text-xs text-primary hover:text-primary/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add {isWorkout ? "Workout" : "Pilates"}
                      </button>
                    </>
                  ) : isWorkout ? (
                    <WorkoutDayCard
                      entry={entry as PlannedWorkoutEntry}
                      onEdit={() => setEditingDay(weekday)}
                      onDelete={() => deleteEntry(entry.id)}
                      onUnmatch={() => unmatchEntry(entry.id)}
                    />
                  ) : (
                    <PilatesDayCard
                      entry={entry as PlannedPilatesEntry}
                      onEdit={() => setEditingDay(weekday)}
                      onDelete={() => deleteEntry(entry.id)}
                      onUnmatch={() => unmatchEntry(entry.id)}
                    />
                  )}
                </div>

                {isEditing && (
                  <div className="pb-2">
                    {isWorkout ? (
                      <WorkoutEntryEditor
                        entry={
                          (entry as PlannedWorkoutEntry | undefined) ??
                          (newEntryFor(weekday) as PlannedWorkoutEntry)
                        }
                        onSave={saveEntry}
                        onCancel={() => setEditingDay(null)}
                      />
                    ) : (
                      <PilatesEntryEditor
                        entry={
                          (entry as PlannedPilatesEntry | undefined) ??
                          (newEntryFor(weekday) as PlannedPilatesEntry)
                        }
                        onSave={saveEntry}
                        onCancel={() => setEditingDay(null)}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete this plan?"
        message="This will permanently delete the plan and all its sessions."
        confirmLabel="Delete Plan"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
        loading={saving}
      />
    </div>
  );
}
