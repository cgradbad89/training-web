"use client";

/**
 * Workout plan detail view.
 *
 * Renders a single WorkoutPlan. Each day can be either:
 *   - Exercise-based (exercises[] non-empty) — strength / HIIT / OTF
 *   - Duration-only (duration_mins set, exercises empty) — pilates, yoga,
 *     cardio, etc. This replaced the former standalone Pilates plan type.
 *
 * All edits are autosaved via the onUpdate callback.
 */

import React, {
  useState,
  useMemo,
  useRef,
  useLayoutEffect,
  useEffect,
} from "react";
import Link from "next/link";
import {
  Pencil,
  Trash2,
  Plus,
  X,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
} from "lucide-react";

import {
  type WorkoutPlan,
  type PlannedWorkoutEntry,
  type PlanExercise,
  type PlanWorkoutWeek,
  isDurationOnlyEntry,
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

function formatCompletedAt(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

// ─── Auto-expanding textarea ────────────────────────────────────────────────

interface AutoTextareaProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: string;
  maxLength?: number;
  autoFocus?: boolean;
  className?: string;
  onBlur?: () => void;
}

function AutoTextarea({
  value,
  onChange,
  placeholder,
  minHeight = "2.5rem",
  maxLength,
  autoFocus,
  className = "",
  onBlur,
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Resize to fit content on every value change
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) =>
        onChange(maxLength ? e.target.value.slice(0, maxLength) : e.target.value)
      }
      onBlur={onBlur}
      placeholder={placeholder}
      autoFocus={autoFocus}
      rows={1}
      style={{ minHeight, resize: "none" }}
      className={`w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary placeholder:text-textSecondary focus:outline-none focus:ring-2 focus:ring-primary ${className}`}
    />
  );
}

// ─── Entry editor (unified: exercise-based OR duration-only) ───────────────

interface EntryEditorProps {
  entry: PlannedWorkoutEntry;
  onSave: (entry: PlannedWorkoutEntry) => void;
  onCancel: () => void;
}

function EntryEditor({ entry, onSave, onCancel }: EntryEditorProps) {
  const [label, setLabel] = useState(entry.label ?? "");
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [exercises, setExercises] = useState<PlanExercise[]>(
    entry.exercises ?? []
  );
  const [durationStr, setDurationStr] = useState(
    entry.duration_mins != null ? String(entry.duration_mins) : ""
  );
  const [mode, setMode] = useState<"exercises" | "duration">(() =>
    isDurationOnlyEntry(entry) ? "duration" : "exercises"
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
    const trimmedLabel = label.trim() || undefined;
    const trimmedNotes = notes.trim() || undefined;
    if (mode === "duration") {
      const dur = parseInt(durationStr, 10);
      onSave({
        ...entry,
        type: "workout",
        label: trimmedLabel,
        notes: trimmedNotes,
        exercises: [],
        duration_mins: isNaN(dur) ? undefined : dur,
      });
    } else {
      onSave({
        ...entry,
        type: "workout",
        label: trimmedLabel,
        notes: trimmedNotes,
        exercises: exercises.filter((ex) => ex.name.trim().length > 0),
        duration_mins: undefined,
      });
    }
  }

  return (
    <div className="bg-surface rounded-xl p-4 mx-3 mb-2 border border-border">
      {/* Mode toggle */}
      <div className="flex rounded-lg border border-border overflow-hidden mb-3">
        <button
          type="button"
          onClick={() => setMode("exercises")}
          className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
            mode === "exercises"
              ? "bg-primary text-white"
              : "bg-card text-textSecondary hover:bg-surface"
          }`}
        >
          Exercises
        </button>
        <button
          type="button"
          onClick={() => setMode("duration")}
          className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
            mode === "duration"
              ? "bg-primary text-white"
              : "bg-card text-textSecondary hover:bg-surface"
          }`}
        >
          Duration
        </button>
      </div>

      {/* Label */}
      <div className="mb-3">
        <AutoTextarea
          value={label}
          onChange={setLabel}
          placeholder={
            mode === "exercises" ? "Label (e.g. Upper Body)" : "Label (e.g. Reformer Pilates)"
          }
          maxLength={200}
          autoFocus
        />
      </div>

      {mode === "duration" ? (
        <div className="flex items-center gap-2 mb-3">
          <input
            type="number"
            value={durationStr}
            onChange={(e) => setDurationStr(e.target.value)}
            placeholder="Duration"
            min={0}
            className="flex-1 text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary"
          />
          <span className="text-sm text-textSecondary shrink-0">min</span>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 mb-3">
            {exercises.length === 0 && (
              <p className="text-xs text-textSecondary italic">
                No exercises yet
              </p>
            )}
            {exercises.map((ex) => (
              <div key={ex.id} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={ex.name}
                  onChange={(e) =>
                    updateExercise(ex.id, { name: e.target.value })
                  }
                  placeholder="Exercise"
                  className="flex-1 min-w-0 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
                />
                <input
                  type="number"
                  value={ex.sets}
                  min={0}
                  onChange={(e) =>
                    updateExercise(ex.id, {
                      sets: parseInt(e.target.value, 10) || 0,
                    })
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
                    updateExercise(ex.id, {
                      reps: parseInt(e.target.value, 10) || 0,
                    })
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
        </>
      )}

      {/* Quick notes — optional single-line */}
      <AutoTextarea
        value={notes}
        onChange={setNotes}
        placeholder="Quick notes (optional)"
        maxLength={200}
        className="mb-3"
      />

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

// ─── Day card (unified) ─────────────────────────────────────────────────────

function DayCard({
  entry,
  onEdit,
  onDelete,
  onUnmatch,
  onNotesChange,
  detailHref,
}: {
  entry: PlannedWorkoutEntry;
  onEdit: () => void;
  onDelete: () => void;
  onUnmatch: () => void;
  onNotesChange: (notes: string) => void;
  /** Link to workout detail page (only for exercise-based sessions). */
  detailHref: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [notesOpen, setNotesOpen] = useState(!!entry.notes?.trim());
  const [notesDraft, setNotesDraft] = useState(entry.notes ?? "");

  // Keep local draft in sync if the parent prop changes (e.g. after a copy-week)
  useEffect(() => {
    setNotesDraft(entry.notes ?? "");
    setNotesOpen(!!entry.notes?.trim());
  }, [entry.id, entry.notes]);

  const isDurationOnly = isDurationOnlyEntry(entry);
  const exCount = entry.exercises?.length ?? 0;
  const completed = entry.completed === true;
  const completedLabel = formatCompletedAt(entry.completedAt);
  const notesHasContent = notesDraft.trim().length > 0;
  const notesFirstLine = notesDraft.split("\n")[0].trim();

  return (
    <div
      className={`flex-1 border-l-4 border-purple-400 rounded-r-lg pl-3 pr-2 py-2 ${
        completed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 text-left flex items-center gap-2 flex-wrap"
        >
          <span className="text-xs font-bold uppercase tracking-wide text-purple-600">
            {isDurationOnly ? "Session" : "Workout"}
          </span>
          {entry.label && (
            <span className="text-sm font-semibold text-textPrimary">
              {entry.label}
            </span>
          )}
          {isDurationOnly && entry.duration_mins != null ? (
            <span className="text-xs text-textSecondary">
              · {entry.duration_mins} min
            </span>
          ) : (
            <span className="text-xs text-textSecondary">
              · {exCount} {exCount === 1 ? "exercise" : "exercises"}
            </span>
          )}
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

      {/* Exercise list expansion */}
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

      {/* Collapsible per-day notes */}
      <div className="mt-2">
        <button
          onClick={() => setNotesOpen((v) => !v)}
          className="text-xs text-textSecondary hover:text-textPrimary flex items-center gap-1"
        >
          {notesHasContent ? (
            <>
              <span>Notes {notesOpen ? "▴" : "▾"}</span>
              {!notesOpen && notesFirstLine && (
                <span className="italic text-textSecondary truncate max-w-[200px]">
                  — {notesFirstLine}
                </span>
              )}
            </>
          ) : (
            <span className="opacity-70">＋ Add notes</span>
          )}
        </button>
        {notesOpen && (
          <AutoTextarea
            value={notesDraft}
            onChange={setNotesDraft}
            placeholder="Free-form instructions (e.g. Superset sets 1-3, rest 90s)"
            minHeight="4rem"
            maxLength={1000}
            onBlur={() => {
              if (notesDraft !== (entry.notes ?? "")) {
                onNotesChange(notesDraft);
              }
            }}
            className="mt-1.5"
          />
        )}
      </div>

      {/* View Workout link — exercise-based sessions only */}
      {detailHref && (
        <Link
          href={detailHref}
          className="text-xs text-primary hover:text-primary/80 font-medium mt-2 inline-flex items-center gap-0.5"
        >
          View Workout →
        </Link>
      )}
    </div>
  );
}

// ─── Plan detail component ─────────────────────────────────────────────────

interface CrossTrainingPlanDetailProps {
  plan: WorkoutPlan;
  onUpdate: (plan: WorkoutPlan) => void | Promise<void>;
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
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [editingDay, setEditingDay] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Copy-week UI state
  const [copyWeekOpen, setCopyWeekOpen] = useState(false);
  const [copyFlashText, setCopyFlashText] = useState<string | null>(null);

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

  function updateWeekEntries(nextEntries: PlannedWorkoutEntry[]) {
    const updatedWeeks: PlanWorkoutWeek[] = plan.weeks.map((w, i) =>
      i === selectedWeekIndex ? { ...w, entries: nextEntries } : w
    );
    onUpdate({ ...plan, weeks: updatedWeeks });
  }

  function saveEntry(updated: PlannedWorkoutEntry) {
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
      const cleared = { ...e, completed: false };
      delete cleared.completedAt;
      return cleared;
    });
    updateWeekEntries(next);
  }

  function updateEntryNotes(id: string, notes: string) {
    const next = sortedEntries.map((e) =>
      e.id === id ? { ...e, notes: notes.trim() || undefined } : e
    );
    updateWeekEntries(next);
  }

  function newEntryFor(weekday: number): PlannedWorkoutEntry {
    return {
      id: crypto.randomUUID(),
      weekIndex: selectedWeekIndex,
      weekday,
      dayOfWeek: weekday - 1,
      type: "workout",
      exercises: [],
    };
  }

  /**
   * Deep copy the current week's entries into the target week, reassigning
   * weekIndex and generating fresh UUIDs for every entry and nested
   * exercise. Clears completed flags on the copies.
   */
  function copyWeekTo(targetWeekIndex: number) {
    if (targetWeekIndex === selectedWeekIndex) return;
    if (targetWeekIndex < 0 || targetWeekIndex >= plan.weeks.length) return;

    const copiedEntries: PlannedWorkoutEntry[] = sortedEntries.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
      weekIndex: targetWeekIndex,
      completed: false,
      completedAt: undefined,
      exercises: (e.exercises ?? []).map((ex) => ({
        ...ex,
        id: crypto.randomUUID(),
      })),
    }));

    const updatedWeeks: PlanWorkoutWeek[] = plan.weeks.map((w, i) =>
      i === targetWeekIndex ? { ...w, entries: copiedEntries } : w
    );
    onUpdate({ ...plan, weeks: updatedWeeks });

    const targetWeekNumber = plan.weeks[targetWeekIndex]?.weekNumber ?? targetWeekIndex + 1;
    setCopyFlashText(`✓ Copied to Week ${targetWeekNumber}`);
    setCopyWeekOpen(false);
    setTimeout(() => setCopyFlashText(null), 2000);
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
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
              Workout Plan
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card gap-2">
        <button
          onClick={() => {
            setSelectedWeekIndex((i) => Math.max(0, i - 1));
            setCopyWeekOpen(false);
          }}
          disabled={selectedWeekIndex === 0}
          className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="text-center flex-1 min-w-0">
          <div className="text-sm font-semibold text-textPrimary">
            Week {week?.weekNumber ?? selectedWeekIndex + 1}
          </div>
          <div className="text-xs text-textSecondary">{dateRange}</div>
        </div>

        <div className="flex items-center gap-1 shrink-0 relative">
          {/* Copy week button */}
          <button
            onClick={() => setCopyWeekOpen((v) => !v)}
            disabled={plan.weeks.length <= 1}
            title={
              plan.weeks.length <= 1
                ? "No other weeks to copy to"
                : "Copy this week to another week"
            }
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Copy className="w-3 h-3" />
            Copy week →
          </button>
          {copyFlashText && (
            <span className="text-xs text-success font-medium ml-1 whitespace-nowrap">
              {copyFlashText}
            </span>
          )}
          {copyWeekOpen && plan.weeks.length > 1 && (
            <div className="absolute right-0 top-full mt-1 z-10 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px] max-h-64 overflow-y-auto">
              <div className="text-[10px] font-bold uppercase tracking-wide text-textSecondary px-3 py-1">
                Copy to week…
              </div>
              {plan.weeks.map((w, i) =>
                i === selectedWeekIndex ? null : (
                  <button
                    key={w.weekNumber}
                    onClick={() => copyWeekTo(i)}
                    className="w-full text-left px-3 py-1.5 text-xs text-textPrimary hover:bg-surface flex items-center justify-between"
                  >
                    <span>Week {w.weekNumber}</span>
                    {w.entries.length > 0 && (
                      <span className="text-textSecondary text-[10px]">
                        will overwrite
                      </span>
                    )}
                  </button>
                )
              )}
            </div>
          )}

          <button
            onClick={() => {
              setSelectedWeekIndex((i) =>
                Math.min(plan.weeks.length - 1, i + 1)
              );
              setCopyWeekOpen(false);
            }}
            disabled={selectedWeekIndex >= plan.weeks.length - 1}
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
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
                <div className="flex items-start gap-3 py-2 px-3 hover:bg-surface/50 group min-h-[52px]">
                  <div className="w-14 shrink-0 pt-1">
                    <div className="text-xs font-bold text-textSecondary">
                      {DAY_ABBREVS[weekday - 1]}
                    </div>
                    <div className="text-xs text-textSecondary">
                      {dateLabel}
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="flex-1 min-w-0 pt-1">
                      <span className="text-sm text-textSecondary italic">
                        {entry ? "Editing…" : "Adding session…"}
                      </span>
                    </div>
                  ) : !entry || entry.type === "rest" ? (
                    <>
                      <span className="text-sm text-textSecondary italic flex-1 pt-1">
                        Rest
                      </span>
                      <button
                        onClick={() => setEditingDay(weekday)}
                        className="text-xs text-primary hover:text-primary/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 pt-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Session
                      </button>
                    </>
                  ) : (
                    <DayCard
                      entry={entry}
                      onEdit={() => setEditingDay(weekday)}
                      onDelete={() => deleteEntry(entry.id)}
                      onUnmatch={() => unmatchEntry(entry.id)}
                      onNotesChange={(notes) => updateEntryNotes(entry.id, notes)}
                      detailHref={
                        !isDurationOnlyEntry(entry) && (entry.exercises?.length ?? 0) > 0
                          ? `/workout/${plan.id}/${selectedWeekIndex}/${weekday}`
                          : null
                      }
                    />
                  )}
                </div>

                {isEditing && (
                  <div className="pb-2">
                    <EntryEditor
                      entry={entry ?? newEntryFor(weekday)}
                      onSave={saveEntry}
                      onCancel={() => setEditingDay(null)}
                    />
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
