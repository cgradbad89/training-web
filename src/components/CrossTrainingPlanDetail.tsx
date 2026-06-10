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
 *
 * Features:
 *   - Drag-to-move days within a week (HTML5 drag API)
 *   - Copy day to any week/weekday
 *   - Copy week to another week (existing)
 *   - Copy entire plan with a new name
 */

import React, {
  useState,
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
  Copy,
} from "lucide-react";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";

import {
  type WorkoutPlan,
  type PlannedWorkoutEntry,
  type PlanExercise,
  type ExerciseItem,
  type WorkoutCategory,
  isDurationOnlyEntry,
  isExerciseItem,
  isSectionItem,
  normalizeExerciseItem,
  WORKOUT_CATEGORY_LABELS,
} from "@/types/plan";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PlanDateEditor } from "@/components/PlanDateEditor";
import { deepCopyWorkoutEntry } from "@/utils/planCopy";
import { snapToMonday, upcomingMonday } from "@/utils/planDateEdit";
import { formatCompletedAt } from "@/utils/planFormat";
import { PlanCompletionSummary } from "@/components/PlanCompletionSummary";
import { PlanEditor, type PlanEditorConfig } from "@/components/PlanEditor";
import {
  makeNewWorkoutEntry,
  workoutWeekSummaryLabel,
} from "@/utils/planEditorLogic";

const CATEGORY_ORDER: WorkoutCategory[] = [
  "strength", "orangetheory", "cycling", "pilates", "yoga", "hiit",
];

// TODO: review for dark mode — category pills use per-activity brand hues
// (Strength=blue, OTF=orange, Cycling=green, etc.) as visual identifiers,
// not theme tokens. Needs a dark-mode-aware palette design pass.
const CATEGORY_COLORS: Record<WorkoutCategory, { active: string; hover: string }> = {
  strength:     { active: "bg-blue-600 text-white border-blue-600",    hover: "hover:bg-blue-50 hover:border-blue-400" },
  orangetheory: { active: "bg-orange-500 text-white border-orange-500", hover: "hover:bg-orange-50 hover:border-orange-400" },
  cycling:      { active: "bg-green-600 text-white border-green-600",   hover: "hover:bg-green-50 hover:border-green-400" },
  pilates:      { active: "bg-purple-500 text-white border-purple-500", hover: "hover:bg-purple-50 hover:border-purple-400" },
  yoga:         { active: "bg-teal-500 text-white border-teal-500",     hover: "hover:bg-teal-50 hover:border-teal-400" },
  hiit:         { active: "bg-red-500 text-white border-red-500",       hover: "hover:bg-red-50 hover:border-red-400" },
};

// ─── Auto-expanding textarea ─────────────────────────────────────────────────

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

// ─── Entry editor (unified: exercise-based OR duration-only) ─────────────────

interface EntryEditorProps {
  entry: PlannedWorkoutEntry;
  isNew: boolean;
  onSave: (entry: PlannedWorkoutEntry) => void;
  onCancel: () => void;
}

function EntryEditor({ entry, isNew, onSave, onCancel }: EntryEditorProps) {
  const [label, setLabel] = useState(entry.label ?? "");
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [category, setCategory] = useState<WorkoutCategory | null>(entry.category ?? null);
  const [items, setItems] = useState<ExerciseItem[]>(() => {
    return (entry.exercises ?? []).map((raw) =>
      normalizeExerciseItem(raw as unknown as Record<string, unknown>)
    );
  });
  const [durationStr, setDurationStr] = useState(
    entry.duration_mins != null ? String(entry.duration_mins) : ""
  );
  const [mode, setMode] = useState<"exercises" | "duration">(() =>
    isDurationOnlyEntry(entry) ? "duration" : "exercises"
  );
  const [notesOpen, setNotesOpen] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (isExerciseItem(item) && item.notes?.trim()) ids.add(item.id);
    }
    return ids;
  });

  function addExercise() {
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "exercise" as const,
        name: "",
        sets: 3,
        reps: 10,
        weight_lbs: 0,
      },
    ]);
  }

  function addSection() {
    setItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), kind: "section" as const, title: "" },
    ]);
  }

  function updateItem(id: string, patch: Partial<PlanExercise> | { title: string }) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
    setNotesOpen((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  function toggleExNotes(id: string) {
    setNotesOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
        category: category ?? undefined,
      });
    } else {
      const cleaned = items.filter((item) =>
        isSectionItem(item)
          ? item.title.trim().length > 0
          : isExerciseItem(item) && item.name.trim().length > 0
      );
      onSave({
        ...entry,
        type: "workout",
        label: trimmedLabel,
        notes: trimmedNotes,
        exercises: cleaned,
        duration_mins: undefined,
        category: category ?? undefined,
      });
    }
  }

  const saveBlocked = isNew && category === null;

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

      {/* Category picker */}
      <div className="mb-3">
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_ORDER.map((cat) => {
            const colors = CATEGORY_COLORS[cat];
            const selected = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(selected ? null : cat)}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                  selected
                    ? colors.active
                    : `bg-card text-textSecondary border-border ${colors.hover}`
                }`}
              >
                {WORKOUT_CATEGORY_LABELS[cat]}
              </button>
            );
          })}
        </div>
        {saveBlocked && (
          <p className="text-xs text-warning mt-1.5">
            Select a category to enable auto-match
          </p>
        )}
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
            {items.length === 0 && (
              <p className="text-xs text-textSecondary italic">
                No exercises yet
              </p>
            )}
            {items.map((item) =>
              // TODO: review for dark mode — section/label/"Exercises" UI uses a
              // purple accent palette (bg-purple-50, text-purple-600/700) as an
              // intentional visual divider, and the "Apply OTF" button at L578
              // uses orange as an OTF brand accent. These are accent colors, not
              // theme tokens; need a design pass to choose dark-mode variants.
              isSectionItem(item) ? (
                <div
                  key={item.id}
                  className="flex items-center gap-1.5 bg-purple-50 rounded-lg px-2 py-1.5 -mx-0.5"
                >
                  <AutoTextarea
                    value={item.title}
                    onChange={(v) => updateItem(item.id, { title: v })}
                    placeholder="Section (e.g. Warm Up, Superset 1)"
                    maxLength={100}
                    className="!bg-transparent !border-0 !ring-0 font-bold text-purple-700 placeholder:text-purple-400 placeholder:font-normal !px-1 !py-0"
                  />
                  <button
                    onClick={() => removeItem(item.id)}
                    className="p-1 rounded hover:bg-danger/10 text-textSecondary hover:text-danger shrink-0"
                    title="Remove section"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : isExerciseItem(item) ? (
                <div key={item.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) => updateItem(item.id, { name: e.target.value })}
                      placeholder="Exercise"
                      className="flex-1 min-w-0 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
                    />
                    <input
                      type="number"
                      value={item.sets}
                      min={0}
                      onChange={(e) =>
                        updateItem(item.id, { sets: parseInt(e.target.value, 10) || 0 })
                      }
                      className="w-12 text-sm border border-border rounded-lg px-1 py-1.5 bg-card text-textPrimary text-center"
                      title="Sets"
                    />
                    <span className="text-xs text-textSecondary">×</span>
                    <input
                      type="number"
                      value={item.reps}
                      min={0}
                      onChange={(e) =>
                        updateItem(item.id, { reps: parseInt(e.target.value, 10) || 0 })
                      }
                      className="w-12 text-sm border border-border rounded-lg px-1 py-1.5 bg-card text-textPrimary text-center"
                      title="Reps"
                    />
                    <input
                      type="number"
                      value={item.weight_lbs}
                      min={0}
                      step={2.5}
                      onChange={(e) =>
                        updateItem(item.id, { weight_lbs: parseFloat(e.target.value) || 0 })
                      }
                      className="w-16 text-sm border border-border rounded-lg px-1 py-1.5 bg-card text-textPrimary text-center"
                      title="Weight (lbs)"
                    />
                    <span className="text-xs text-textSecondary">lbs</span>
                    <button
                      onClick={() => removeItem(item.id)}
                      className="p-1 rounded hover:bg-danger/10 text-textSecondary hover:text-danger"
                      title="Remove exercise"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {notesOpen.has(item.id) ? (
                    <input
                      type="text"
                      value={item.notes ?? ""}
                      onChange={(e) => updateItem(item.id, { notes: e.target.value })}
                      placeholder="Exercise notes (e.g. Pause at bottom)"
                      className="ml-0 text-xs border border-border rounded-lg px-2 py-1 bg-card text-textSecondary placeholder:text-textSecondary"
                    />
                  ) : (
                    <button
                      onClick={() => toggleExNotes(item.id)}
                      className="text-[10px] text-textSecondary hover:text-textPrimary ml-0"
                    >
                      {item.notes?.trim() ? `Note: ${item.notes}` : "＋ note"}
                    </button>
                  )}
                </div>
              ) : null
            )}
          </div>

          <div className="flex gap-3 mb-3">
            <button
              onClick={addExercise}
              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add exercise
            </button>
            <button
              onClick={addSection}
              className="text-xs text-purple-600 hover:text-purple-500 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add section
            </button>
          </div>
        </>
      )}

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
          disabled={saveBlocked}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Check className="w-3 h-3" /> Save
        </button>
      </div>
    </div>
  );
}

// ─── Day card ────────────────────────────────────────────────────────────────

function DayCard({
  entry,
  onEdit,
  onDelete,
  onUnmatch,
  onMarkComplete,
  onNotesChange,
  onCopyDay,
  detailHref,
  isEditingPlan,
}: {
  entry: PlannedWorkoutEntry;
  onEdit: () => void;
  onDelete: () => void;
  onUnmatch: () => void;
  onMarkComplete: () => void;
  onNotesChange: (notes: string) => void;
  onCopyDay: () => void;
  detailHref: string | null;
  isEditingPlan: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [notesOpen, setNotesOpen] = useState(!!entry.notes?.trim());
  const [notesDraft, setNotesDraft] = useState(entry.notes ?? "");

  useEffect(() => {
    setNotesDraft(entry.notes ?? "");
    setNotesOpen(!!entry.notes?.trim());
  }, [entry.id, entry.notes]);

  const isDurationOnly = isDurationOnlyEntry(entry);
  const allItems = entry.exercises ?? [];
  const exCount = allItems.filter((i) => !("kind" in i) || i.kind === "exercise").length;
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
          {!completed && (
            <button
              onClick={onMarkComplete}
              className="text-[10px] text-orange-600 hover:text-orange-700 border border-orange-300 rounded px-1.5 py-0.5 font-medium"
              title="Mark this session complete"
            >
              ✓ Mark Complete
            </button>
          )}
          {isEditingPlan && (
            <>
              <button
                onClick={onCopyDay}
                className="text-[10px] text-textSecondary hover:text-primary border border-border rounded px-1.5 py-0.5 flex items-center gap-0.5"
                title="Copy day to another week"
              >
                <Copy className="w-2.5 h-2.5" />
                Copy
              </button>
              <button
                onClick={onEdit}
                className="p-1 rounded hover:bg-surface text-textSecondary hover:text-textPrimary"
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onDelete}
                className="p-1 rounded hover:bg-danger/10 text-textSecondary hover:text-danger"
                title="Remove"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && allItems.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 pl-1">
          {allItems.map((item) =>
            isSectionItem(item) ? (
              <li
                key={item.id}
                className="text-xs font-bold text-purple-600 pt-1.5 pb-0.5 border-t border-border/40 mt-1 first:mt-0 first:border-0"
              >
                {item.title}
              </li>
            ) : isExerciseItem(item) ? (
              <li key={item.id} className="text-xs text-textSecondary tabular-nums">
                <span className="text-textPrimary font-medium">{item.name}</span>
                {" — "}
                {item.sets} × {item.reps}
                {item.weight_lbs > 0 && ` @ ${item.weight_lbs} lbs`}
                {item.notes?.trim() && (
                  <span className="block text-[10px] text-textSecondary italic pl-2">
                    {item.notes}
                  </span>
                )}
              </li>
            ) : null
          )}
        </ul>
      )}

      {/* Category display (view mode) */}
      {!isEditingPlan && entry.category && (
        <span
          className={`mt-1.5 inline-flex text-[10px] px-2 py-0.5 rounded-full border font-semibold ${CATEGORY_COLORS[entry.category].active}`}
        >
          {WORKOUT_CATEGORY_LABELS[entry.category]}
        </span>
      )}

      <div className="mt-2">
        {!isEditingPlan ? (
          // View mode: read-only notes text
          notesHasContent && (
            <p className="text-xs text-textSecondary italic">{notesDraft}</p>
          )
        ) : (
          // Edit mode: interactive notes toggle + textarea
          <>
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
          </>
        )}
      </div>

      {detailHref && (
        <Link
          href={detailHref}
          className="text-xs text-primary hover:text-primary/80 font-medium mt-2 inline-flex items-center gap-0.5"
        >
          View Workout →
        </Link>
      )}

      {isEditingPlan && !entry.category && (
        <p className="text-[10px] text-warning mt-1.5">
          ⚠ Add category to enable auto-match
        </p>
      )}
    </div>
  );
}

// ─── Plan detail component ────────────────────────────────────────────────────

interface CrossTrainingPlanDetailProps {
  plan: WorkoutPlan;
  onUpdate: (plan: WorkoutPlan) => void | Promise<void>;
  onDelete: () => void;
  onSetActive: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onCopyPlan: (newName: string, startIso: string) => Promise<void>;
  saving: boolean;
  /** Linked race date (ISO) for the in-place editor's race-alignment note. */
  linkedRaceDate?: string;
}

export function CrossTrainingPlanDetail({
  plan,
  onUpdate,
  onDelete,
  onSetActive,
  onComplete,
  onReopen,
  onCopyPlan,
  saving,
  linkedRaceDate,
}: CrossTrainingPlanDetailProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);

  // Copy-plan state
  const [copyPlanOpen, setCopyPlanOpen] = useState(false);
  const [copyPlanName, setCopyPlanName] = useState("");
  const [copyPlanStart, setCopyPlanStart] = useState(() =>
    upcomingMonday(new Date())
  );
  const [copyPlanSaving, setCopyPlanSaving] = useState(false);

  // Inline plan-name editing (in edit mode) — parity with RunningPlanDetail.
  // Persists on blur via onUpdate; Enter commits, Escape reverts.
  const [nameDraft, setNameDraft] = useState(plan.name);

  // Real dirty-state: true ONLY while a mutation's autosave write is in flight,
  // never merely because edit mode is open. Entering edit mode (or opening then
  // cancelling a row editor) changes nothing, so this stays false and the
  // leave-site warning does not arm. Each mutation flips it true → false around
  // the awaited onUpdate write (see `persist`).
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const { showNavWarning, confirmNav, cancelNav } =
    useUnsavedChanges(hasUnsavedChanges);
  // ── Persistence + dirty-state ─────────────────────────────────────────────

  function entriesForWeek(weekIndex: number): PlannedWorkoutEntry[] {
    return plan.weeks[weekIndex]?.entries ?? [];
  }

  function planWithWeekEntries(
    weekIndex: number,
    entries: PlannedWorkoutEntry[]
  ): WorkoutPlan {
    const weeks = plan.weeks.map((w, i) =>
      i === weekIndex ? { ...w, entries } : w
    );
    return { ...plan, weeks };
  }

  // Every edit autosaves immediately. Flag dirty around the awaited write so
  // the leave-site guard only arms for the brief in-flight window, then clears.
  async function persist(updatedPlan: WorkoutPlan) {
    setHasUnsavedChanges(true);
    try {
      await onUpdate(updatedPlan);
    } finally {
      setHasUnsavedChanges(false);
    }
  }

  // Inline rename — mirrors RunningPlanDetail: no-op when blank or unchanged,
  // otherwise persist via the same onUpdate path (self-only single-doc write).
  function handleNameBlur() {
    const name = nameDraft.trim();
    if (!name || name === plan.name) {
      setNameDraft(plan.name);
      return;
    }
    void persist({ ...plan, name });
  }

  // Replace a week's entries — called by PlanEditor for save / delete / drag /
  // copy-day / copy-week.
  function handleUpdateWeek(weekIndex: number, entries: PlannedWorkoutEntry[]) {
    void persist(planWithWeekEntries(weekIndex, entries));
  }

  // ── Entry-level mutations from the row (mark complete / unmatch / notes) ──
  // These act on the entry's own week. Entries carry an accurate weekIndex (set
  // on creation and on every copy) which equals the displayed week.

  function replaceEntry(updated: PlannedWorkoutEntry) {
    const wi = updated.weekIndex;
    const next = entriesForWeek(wi).map((e) =>
      e.id === updated.id ? updated : e
    );
    void persist(planWithWeekEntries(wi, next));
  }

  function markEntryComplete(entry: PlannedWorkoutEntry) {
    replaceEntry({
      ...entry,
      completed: true,
      completedAt: new Date().toISOString(),
    });
  }

  function unmatchEntry(entry: PlannedWorkoutEntry) {
    const cleared = { ...entry, completed: false };
    delete cleared.completedAt;
    replaceEntry(cleared);
  }

  function updateEntryNotes(entry: PlannedWorkoutEntry, notes: string) {
    replaceEntry({ ...entry, notes: notes.trim() || undefined });
  }

  // ── Editor config (type-specific row + inline form wiring) ────────────────

  const editorConfig: PlanEditorConfig<PlannedWorkoutEntry> = {
    planType: "workout",
    renderEntryRow: ({ entry, isEditing, onEdit, onDelete, onCopyDay }) => {
      const daySessions = [...entriesForWeek(entry.weekIndex)]
        .sort((a, b) => a.weekday - b.weekday)
        .filter((e) => e.weekday === entry.weekday && e.type !== "rest");
      const idx = daySessions.findIndex((e) => e.id === entry.id);
      const detailHref =
        !isDurationOnlyEntry(entry) && (entry.exercises?.length ?? 0) > 0
          ? `/workout/${plan.id}/${entry.weekIndex}/${entry.weekday}/${idx}`
          : null;
      return (
        <DayCard
          entry={entry}
          onEdit={onEdit}
          onDelete={onDelete}
          onUnmatch={() => unmatchEntry(entry)}
          onMarkComplete={() => markEntryComplete(entry)}
          onNotesChange={(notes) => updateEntryNotes(entry, notes)}
          onCopyDay={onCopyDay}
          detailHref={detailHref}
          isEditingPlan={isEditing}
        />
      );
    },
    renderEntryEditor: ({ draft, isNew, onSave, onCancel }) => (
      <EntryEditor
        entry={draft}
        isNew={isNew}
        onSave={onSave}
        onCancel={onCancel}
      />
    ),
    makeNewEntry: makeNewWorkoutEntry,
    weekSummaryLabel: workoutWeekSummaryLabel,
    copyEntryToDay: deepCopyWorkoutEntry,
    isRest: (e) => e.type === "rest",
  };

  // ── Copy plan ───────────────────────────────────────────────────────────

  async function handleCopyPlan() {
    const name = copyPlanName.trim();
    if (!name || copyPlanSaving) return;
    setCopyPlanSaving(true);
    try {
      await onCopyPlan(name, copyPlanStart);
      setCopyPlanOpen(false);
      setCopyPlanName("");
    } finally {
      setCopyPlanSaving(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const isCompleted = plan.status === "completed";

  const planEditor = (
    <PlanEditor
      plan={plan}
      entriesForWeek={entriesForWeek}
      config={editorConfig}
      isEditMode={isEditMode}
      onToggleEdit={() => setIsEditMode((v) => !v)}
      onUpdateWeek={handleUpdateWeek}
      onMarkDirty={() => setHasUnsavedChanges(true)}
      onClearDirty={() => setHasUnsavedChanges(false)}
    />
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-card flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            {isEditMode ? (
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setNameDraft(plan.name);
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Plan name"
                aria-label="Plan name"
                className="text-lg font-bold text-textPrimary bg-transparent border-b border-primary outline-none min-w-0 max-w-xs"
                autoFocus
              />
            ) : (
              <h1 className="text-lg font-bold text-textPrimary truncate">
                {plan.name}
              </h1>
            )}
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
              Workout Plan
            </span>
            {plan.status === "active" && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success">
                Active
              </span>
            )}
            {plan.status === "completed" && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-surface text-textSecondary border border-border">
                Completed
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
            {plan.status === "completed" && formatCompletedAt(plan.completedAt) && (
              <>
                {" · "}
                Completed {formatCompletedAt(plan.completedAt)}
              </>
            )}
          </p>
          {isEditMode && (
            <PlanDateEditor
              plan={plan}
              onApply={(updated) => persist(updated as WorkoutPlan)}
              linkedRaceDate={linkedRaceDate}
            />
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {plan.status !== "active" && (
            <button
              onClick={onSetActive}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              Set Active
            </button>
          )}
          {/* Complete (confirm) for any non-completed plan; Reopen (instant)
              once completed. Order mirrors RunningPlanDetail exactly.
              Hidden in edit mode — the Done toggle stands in its place. */}
          {!isEditMode &&
            (plan.status !== "completed" ? (
              <button
                onClick={() => setConfirmComplete(true)}
                disabled={saving}
                className="text-sm px-3 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-50"
              >
                Complete
              </button>
            ) : (
              <button
                onClick={onReopen}
                disabled={saving}
                className="text-sm px-3 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-50"
              >
                Reopen
              </button>
            ))}
          {/* Edit / Done toggle — pure mode toggle; PlanEditor clears any open
              row editor + dirty flag on exit. */}
          <button
            onClick={() => setIsEditMode((v) => !v)}
            className="text-sm px-3 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface"
          >
            {isEditMode ? "Done" : "Edit"}
          </button>
          {/* Copy plan button */}
          <button
            onClick={() => {
              setCopyPlanName(`${plan.name} (copy)`);
              setCopyPlanStart(upcomingMonday(new Date()));
              setCopyPlanOpen(true);
            }}
            disabled={saving}
            title="Copy plan"
            className="flex items-center gap-1 text-sm px-2.5 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-50"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy plan
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={saving}
            title="Delete plan"
            className="p-1.5 rounded-lg hover:bg-danger/10 text-textSecondary hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* When completed, the summary + editor share ONE scroll region so the
          summary renders at full height and all of it is reachable (the editor's
          own internal scroll goes inert here). For active/draft plans (no
          summary) the editor keeps its own flex-1 scroll, unchanged. */}
      {isCompleted ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <PlanCompletionSummary plan={plan} />
          {planEditor}
        </div>
      ) : (
        planEditor
      )}

      {/* ── Dialogs ── */}

      {/* Navigation warning */}
      <ConfirmDialog
        isOpen={showNavWarning}
        title="Exit edit mode?"
        message="You're currently in edit mode. Your changes have been auto-saved."
        confirmLabel="Exit Edit Mode"
        confirmVariant="primary"
        onConfirm={confirmNav}
        onCancel={cancelNav}
      />

      {/* Mark plan completed — clears active; reversible via Reopen */}
      <ConfirmDialog
        isOpen={confirmComplete}
        title="Mark plan as completed?"
        message="This moves the plan to Completed and clears its active status. You can Reopen it later."
        confirmLabel="Mark Completed"
        confirmVariant="primary"
        onConfirm={() => {
          setConfirmComplete(false);
          onComplete();
        }}
        onCancel={() => setConfirmComplete(false)}
        loading={saving}
      />

      {/* Delete plan */}
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

      {/* Copy-plan modal */}
      {copyPlanOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !copyPlanSaving) {
              setCopyPlanOpen(false);
            }
          }}
        >
          <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-xs p-5">
            <h3 className="font-bold text-textPrimary text-sm mb-4">
              Copy plan
            </h3>
            <label className="block text-xs font-semibold text-textSecondary mb-1.5">
              New plan name
            </label>
            <input
              type="text"
              value={copyPlanName}
              onChange={(e) => setCopyPlanName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCopyPlan();
                if (e.key === "Escape" && !copyPlanSaving) setCopyPlanOpen(false);
              }}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-4"
              autoFocus
            />
            <label className="block text-xs font-semibold text-textSecondary mb-1.5">
              Start date
            </label>
            <input
              type="date"
              value={copyPlanStart}
              onChange={(e) =>
                e.target.value && setCopyPlanStart(snapToMonday(e.target.value))
              }
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-1.5"
            />
            <p className="text-xs text-textSecondary mb-4">
              Weeks start Monday — the start date snaps to its Monday.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCopyPlanOpen(false)}
                disabled={copyPlanSaving}
                className="px-4 py-2 rounded-xl border border-border text-sm text-textSecondary hover:bg-surface transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCopyPlan()}
                disabled={!copyPlanName.trim() || copyPlanSaving}
                className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                {copyPlanSaving ? "Copying…" : "Copy plan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
