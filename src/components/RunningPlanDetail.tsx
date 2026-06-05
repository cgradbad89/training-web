"use client";

/**
 * Running plan detail view — rendered INLINE on the Plans page (no route nav).
 *
 * Mirrors CrossTrainingPlanDetail: owns the header (Set Active / Edit Plan↔Done
 * / Copy plan / rename / delete) + real dirty-state, and mounts the shared
 * PlanEditor for the single-week-paginated editing UI. The type-specific row
 * (run-type badge, distance/pace/HR/notes + planMatching status) and the inline
 * EntryForm are supplied via PlanEditorConfig. All edits autosave via onUpdate.
 *
 * Match status (completed/missed/upcoming) is computed with the SAME
 * matchPlanToActual / statusForRunEntry the running view uses — no new logic.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import {
  Pencil,
  Trash2,
  Copy,
  X,
  Check,
  CheckCircle,
  Circle,
  AlertCircle,
} from "lucide-react";

import {
  type RunningPlan,
  type PlannedRunEntry,
  type PlanRunType,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { matchPlanToActual, statusForRunEntry } from "@/utils/planMatching";
import { formatPace, parsePaceString } from "@/utils/pace";
import { deepCopyRunEntry } from "@/utils/planCopy";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PlanEditor, type PlanEditorConfig } from "@/components/PlanEditor";
import {
  makeNewRunEntry,
  runningWeekSummaryLabel,
  computeWeekCompletion,
} from "@/utils/planEditorLogic";

// ─── Constants ────────────────────────────────────────────────────────────────

// TODO: review for dark mode — run-type pills use per-type brand hues
// (Outdoor=green, Treadmill=blue, OTF=orange, LongRun=purple, Rest=gray) as
// visual identifiers, not theme tokens. Needs a dark-mode-aware palette pass.
const RUN_TYPE_STYLES: Record<
  PlanRunType,
  { bg: string; text: string; label: string }
> = {
  outdoor:   { bg: "bg-green-100",  text: "text-green-700",  label: "Outdoor"   },
  treadmill: { bg: "bg-blue-100",   text: "text-blue-700",   label: "Treadmill" },
  otf:       { bg: "bg-orange-100", text: "text-orange-700", label: "OTF"       },
  longRun:   { bg: "bg-purple-100", text: "text-purple-700", label: "Long Run"  },
  rest:      { bg: "bg-gray-100",   text: "text-gray-400",   label: "Rest"      },
};

const RUN_TYPES_OPTIONS: { value: PlanRunType; label: string }[] = [
  { value: "outdoor",   label: "Outdoor"   },
  { value: "treadmill", label: "Treadmill" },
  { value: "otf",       label: "OTF"       },
  { value: "longRun",   label: "Long Run"  },
];

// ─── RunTypeBadge ───────────────────────────────────────────────────────────

function RunTypeBadge({ type }: { type: PlanRunType }) {
  const s = RUN_TYPE_STYLES[type];
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

// ─── Entry Form (reproduced from the legacy /edit route) ──────────────────────

interface EntryFormProps {
  initial: Partial<PlannedRunEntry>;
  weekday: number;
  weekIndex: number;
  onSave: (entry: PlannedRunEntry) => void;
  onCancel: () => void;
}

function EntryForm({ initial, weekday, weekIndex, onSave, onCancel }: EntryFormProps) {
  const initRunType =
    initial.runType && initial.runType !== "rest" ? initial.runType : "outdoor";

  const [runType, setRunType] = useState<PlanRunType>(initRunType);
  const [description, setDescription] = useState(initial.description ?? "");
  // A 0 default (new entry) renders empty so the field reads as blank, not "0".
  const [distanceMiles, setDistanceMiles] = useState(
    initial.distanceMiles ? String(initial.distanceMiles) : ""
  );
  const [paceInput, setPaceInput] = useState(initial.paceTarget ?? "");
  const [targetHeartRate, setTargetHeartRate] = useState(
    initial.targetHeartRate != null ? String(initial.targetHeartRate) : ""
  );
  const [notes, setNotes] = useState(initial.notes ?? "");

  function handleSave() {
    const dist = parseFloat(distanceMiles);
    if (isNaN(dist) || dist <= 0) return;
    const hr = targetHeartRate ? parseInt(targetHeartRate, 10) : null;

    const parsedPace = parsePaceString(paceInput.trim());
    const paceTarget = parsedPace
      ? formatPace(parsedPace)
      : paceInput.trim() || undefined;

    onSave({
      id: initial.id ?? crypto.randomUUID(),
      weekIndex,
      weekday,
      dayOfWeek: weekday - 1,
      distanceMiles: dist,
      runType,
      paceTarget,
      description: description.trim() || undefined,
      notes: notes.trim() || undefined,
      targetHeartRate: hr,
    });
  }

  return (
    <div className="bg-surface rounded-xl p-4 mx-4 mb-2 border border-border">
      {/* Run type segmented */}
      <div className="flex rounded-lg border border-border overflow-hidden mb-3">
        {RUN_TYPES_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setRunType(value)}
            className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
              runType === value
                ? "bg-primary text-white"
                : "bg-card text-textSecondary hover:bg-surface"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
        <div className="md:col-span-2">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Easy effort with strides"
            className="w-full text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          />
        </div>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={distanceMiles}
            onChange={(e) => setDistanceMiles(e.target.value)}
            placeholder="Distance"
            step="0.1"
            min="0"
            className="flex-1 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          />
          <span className="text-sm text-textSecondary shrink-0">mi</span>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={paceInput}
            onChange={(e) => setPaceInput(e.target.value)}
            placeholder="M:SS"
            className="flex-1 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          />
          <span className="text-sm text-textSecondary shrink-0">/mi</span>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={targetHeartRate}
            onChange={(e) => setTargetHeartRate(e.target.value)}
            placeholder="HR"
            min="0"
            max="250"
            className="flex-1 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          />
          <span className="text-sm text-textSecondary shrink-0">bpm</span>
        </div>
        <div>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 200))}
            placeholder="Notes (optional)"
            className="w-full text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary placeholder:text-textSecondary"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-3 py-1.5 text-xs text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
        >
          <X className="w-3 h-3" /> Cancel
        </button>
        <button
          onClick={handleSave}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Check className="w-3 h-3" /> Save Entry
        </button>
      </div>
    </div>
  );
}

// ─── Plan detail component ────────────────────────────────────────────────────

interface RunningPlanDetailProps {
  plan: RunningPlan;
  activities: HealthWorkout[];
  onUpdate: (updated: RunningPlan) => void | Promise<void>;
  onDelete: () => void;
  onSetActive: () => void;
  onCopyPlan: (newName: string) => void | Promise<void>;
  /** 0-based week to land on initially (e.g. calendar deep-link). Optional. */
  initialWeekIndex?: number;
}

export function RunningPlanDetail({
  plan,
  activities,
  onUpdate,
  onDelete,
  onSetActive,
  onCopyPlan,
  initialWeekIndex,
}: RunningPlanDetailProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Copy-plan modal
  const [copyPlanOpen, setCopyPlanOpen] = useState(false);
  const [copyPlanName, setCopyPlanName] = useState("");
  const [copyPlanSaving, setCopyPlanSaving] = useState(false);

  // Inline plan-name editing (in edit mode) — replaces the standalone rename
  // pencil/modal. Persists on blur via onUpdate (mirrors the legacy /edit route).
  const [nameDraft, setNameDraft] = useState(plan.name);

  // Real dirty-state: true only while a mutation's autosave is in flight (same
  // model as the workout flow) — NOT the edit-mode boolean.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const { showNavWarning, confirmNav, cancelNav } =
    useUnsavedChanges(hasUnsavedChanges);

  const matchMap = useMemo(
    () => matchPlanToActual(plan, activities),
    [plan, activities]
  );

  // ── Persistence + dirty-state ─────────────────────────────────────────────

  function entriesForWeek(weekIndex: number): PlannedRunEntry[] {
    return plan.weeks[weekIndex]?.entries ?? [];
  }

  function planWithWeekEntries(
    weekIndex: number,
    entries: PlannedRunEntry[]
  ): RunningPlan {
    const weeks = plan.weeks.map((w, i) =>
      i === weekIndex ? { ...w, entries } : w
    );
    return { ...plan, weeks };
  }

  // Every edit autosaves immediately. Flag dirty around the awaited write so the
  // leave-site guard only arms for the brief in-flight window, then clears.
  async function persist(updatedPlan: RunningPlan) {
    setHasUnsavedChanges(true);
    try {
      await onUpdate(updatedPlan);
    } finally {
      setHasUnsavedChanges(false);
    }
  }

  // Replace a week's entries — called by PlanEditor for save / delete / drag /
  // copy-day / copy-week.
  function handleUpdateWeek(weekIndex: number, entries: PlannedRunEntry[]) {
    void persist(planWithWeekEntries(weekIndex, entries));
  }

  async function handleCopyPlan() {
    const name = copyPlanName.trim();
    if (!name || copyPlanSaving) return;
    setCopyPlanSaving(true);
    try {
      await onCopyPlan(name);
      setCopyPlanOpen(false);
      setCopyPlanName("");
    } finally {
      setCopyPlanSaving(false);
    }
  }

  function handleNameBlur() {
    const name = nameDraft.trim();
    if (!name || name === plan.name) {
      setNameDraft(plan.name);
      return;
    }
    void persist({ ...plan, name });
  }

  // ── Editor config (type-specific row + inline form wiring) ────────────────

  const editorConfig: PlanEditorConfig<PlannedRunEntry> = {
    planType: "running",
    renderEntryRow: ({ entry, isEditing, onEdit, onDelete: onDeleteEntry, onCopyDay }) => {
      const status = statusForRunEntry(plan, entry, matchMap);
      const match = matchMap.get(entry.id);

      let statusIcon: ReactNode;
      if (status === "met") {
        statusIcon = <CheckCircle className="w-4 h-4 text-success shrink-0" />;
      } else if (status === "partial") {
        statusIcon = <Check className="w-4 h-4 text-warning shrink-0" />;
      } else if (status === "missed") {
        statusIcon = <AlertCircle className="w-4 h-4 text-danger shrink-0" />;
      } else {
        statusIcon = <Circle className="w-4 h-4 text-border shrink-0" />;
      }

      // Copy button shows on the day's first entry only (matches legacy /edit).
      const daySessions = [...entriesForWeek(entry.weekIndex)]
        .sort((a, b) => a.weekday - b.weekday)
        .filter((e) => e.weekday === entry.weekday && e.runType !== "rest");
      const idx = daySessions.findIndex((e) => e.id === entry.id);

      return (
        <div className="flex items-center gap-2">
          <div className="w-4 shrink-0">{statusIcon}</div>
          <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
            {entry.runType && entry.runType !== "rest" && (
              <RunTypeBadge type={entry.runType} />
            )}
            {entry.description && (
              <span className="text-sm text-textSecondary">{entry.description}</span>
            )}
            <span className="text-sm font-semibold text-textPrimary tabular-nums">
              {entry.distanceMiles.toFixed(1)} mi
            </span>
            {entry.paceTarget && (
              <span className="text-sm text-textSecondary">@ {entry.paceTarget}/mi</span>
            )}
            {entry.targetHeartRate && (
              <span className="text-xs text-textSecondary">
                HR: {entry.targetHeartRate} bpm
              </span>
            )}
            {entry.notes && (
              <span className="text-xs text-textSecondary italic">{entry.notes}</span>
            )}
            {match && (
              <span
                className={`text-xs ${
                  match.quality === "full" ? "text-success" : "text-warning"
                }`}
              >
                {match.quality === "full" ? "✓" : "~"}{" "}
                {match.activity.distanceMiles.toFixed(1)} mi ·{" "}
                {match.activity.avgPaceSecPerMile
                  ? `${Math.floor(match.activity.avgPaceSecPerMile / 60)}:${String(
                      Math.round(match.activity.avgPaceSecPerMile % 60)
                    ).padStart(2, "0")}/mi`
                  : "—"}
                {match.activity.avgHeartRate != null && (
                  <span className="text-xs text-textSecondary ml-1">
                    · {Math.round(match.activity.avgHeartRate)} bpm
                  </span>
                )}
              </span>
            )}
          </div>
          {isEditing && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {idx === 0 && (
                <button
                  onClick={onCopyDay}
                  className="text-[10px] text-textSecondary hover:text-primary border border-border rounded px-1.5 py-0.5 flex items-center gap-0.5"
                  title="Copy day to another week"
                >
                  <Copy className="w-2.5 h-2.5" />
                  Copy
                </button>
              )}
              <button
                onClick={onEdit}
                className="p-1 rounded hover:bg-border text-textSecondary hover:text-textPrimary"
                title="Edit entry"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onDeleteEntry}
                className="p-1 rounded hover:bg-danger/10 text-textSecondary hover:text-danger"
                title="Delete entry"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      );
    },
    renderEntryEditor: ({ draft, onSave, onCancel }) => (
      <EntryForm
        initial={draft}
        weekday={draft.weekday}
        weekIndex={draft.weekIndex}
        onSave={onSave}
        onCancel={onCancel}
      />
    ),
    makeNewEntry: makeNewRunEntry,
    weekSummaryLabel: runningWeekSummaryLabel,
    copyEntryToDay: deepCopyRunEntry,
    isRest: (e) => e.runType === "rest",
    renderWeekAccessory: (entries) => {
      if (entries.filter((e) => e.runType !== "rest").length === 0) return null;
      const { completedRuns, totalRuns, plannedMiles, actualMiles, pct } =
        computeWeekCompletion(entries, (id) => {
          const m = matchMap.get(id);
          return m ? m.activity.distanceMiles : null;
        });
      return (
        <div className="mt-4 p-3 rounded-xl bg-surface border border-border">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-textSecondary">
              {completedRuns} / {totalRuns} runs · {actualMiles.toFixed(1)} /{" "}
              {plannedMiles.toFixed(1)} mi
            </span>
            <span
              className={`font-medium ${
                pct >= 1 ? "text-success" : "text-textSecondary"
              }`}
            >
              {Math.round(pct * 100)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-border overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                pct >= 1 ? "bg-success" : "bg-primary"
              }`}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        </div>
      );
    },
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
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

        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {!plan.isActive && (
            <button
              onClick={onSetActive}
              className="text-sm px-3 py-1.5 rounded-lg bg-primary text-white font-medium hover:bg-primary/90"
            >
              Set Active
            </button>
          )}
          {/* Edit / Done toggle — toggles in-place edit. In edit mode the plan
              name above becomes inline-editable (no separate rename control). */}
          <button
            onClick={() => setIsEditMode((v) => !v)}
            className="text-sm px-3 py-1.5 rounded-lg border border-border text-textPrimary font-medium hover:bg-surface"
          >
            {isEditMode ? "Done" : "Edit"}
          </button>
          {/* Copy plan */}
          <button
            onClick={() => {
              setCopyPlanName(`${plan.name} (copy)`);
              setCopyPlanOpen(true);
            }}
            title="Copy plan"
            className="flex items-center gap-1 text-sm px-2.5 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy plan
          </button>
          {/* Delete */}
          <button
            onClick={() => setConfirmDelete(true)}
            title="Delete plan"
            className="p-1.5 rounded-lg hover:bg-red-50 text-textSecondary hover:text-danger"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <PlanEditor
        plan={plan}
        entriesForWeek={entriesForWeek}
        config={editorConfig}
        isEditMode={isEditMode}
        onToggleEdit={() => setIsEditMode((v) => !v)}
        onUpdateWeek={handleUpdateWeek}
        onMarkDirty={() => setHasUnsavedChanges(true)}
        onClearDirty={() => setHasUnsavedChanges(false)}
        initialWeekIndex={initialWeekIndex}
      />

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

      {/* Delete plan */}
      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete this plan?"
        message="This will permanently delete the plan and all its workouts."
        confirmLabel="Delete Plan"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
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
            <h3 className="font-bold text-textPrimary text-sm mb-4">Copy plan</h3>
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
