"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { ChevronDown, ChevronUp, Pencil, X, Check, Plus, Copy } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { fetchPlans, updatePlan, createPlan } from "@/services/plans";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import {
  type RunningPlan,
  type PlannedRunEntry,
  type PlanWeek,
  type PlanRunType,
  isRunningPlan,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { formatPace, parsePaceString } from "@/utils/pace";
import { matchWeekRuns, type WeekMatchResult } from "@/utils/planMatching";
import { deepCopyRunEntry, deepCopyRunWeek, deepCopyRunningPlan } from "@/utils/planCopy";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// ─── Constants ─────────────────────────────────────────────────────────────────

// TODO: review for dark mode — run-type pills use per-type brand hues
// (Outdoor=green, Treadmill=blue, OTF=orange, LongRun=purple, Rest=gray)
// as visual identifiers, not theme tokens. Needs a dark-mode-aware
// palette design pass.
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

const DAY_ABBREVS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_SHORT   = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const RUN_TYPES_OPTIONS: { value: PlanRunType; label: string }[] = [
  { value: "outdoor",   label: "Outdoor"   },
  { value: "treadmill", label: "Treadmill" },
  { value: "otf",       label: "OTF"       },
  { value: "longRun",   label: "Long Run"  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function dayDate(plan: RunningPlan, weekIndex: number, weekday: number): Date {
  const [year, month, day] = plan.startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const offset = weekIndex * 7 + (weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + offset);
  return d;
}

function weekDateRange(plan: RunningPlan, weekIdx: number): string {
  const start = new Date(plan.startDate + "T00:00:00");
  start.setDate(start.getDate() + weekIdx * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function weekPlannedMiles(week: PlanWeek): number {
  return week.entries
    .filter((e) => e.runType !== "rest")
    .reduce((s, e) => s + e.distanceMiles, 0);
}

function currentWeekIndex(plan: RunningPlan): number {
  const start = new Date(plan.startDate + "T00:00:00");
  const today = new Date();
  const diff = Math.floor(
    (today.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000)
  );
  return Math.max(0, Math.min(diff, plan.weeks.length - 1));
}

// ─── RunTypeBadge ──────────────────────────────────────────────────────────────

function RunTypeBadge({ type }: { type: PlanRunType }) {
  const s = RUN_TYPE_STYLES[type];
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

// ─── WeekStatusBadge ───────────────────────────────────────────────────────────

function WeekStatusBadge({ result }: { result: WeekMatchResult }) {
  if (result.status === "upcoming") return null;

  const { status, planned, actual } = result;
  const label = `${actual.toFixed(1)} / ${planned.toFixed(1)} mi`;

  const cls =
    status === "met"
      ? "bg-success/10 text-success"
      : status === "partial"
      ? "bg-warning/10 text-warning"
      : "bg-surface text-textSecondary";

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

// ─── Entry Form ────────────────────────────────────────────────────────────────

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
  const [distanceMiles, setDistanceMiles] = useState(
    initial.distanceMiles != null ? String(initial.distanceMiles) : ""
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

// ─── WeekAccordion ─────────────────────────────────────────────────────────────

interface WeekAccordionProps {
  plan: RunningPlan;
  weekIndex: number;
  isExpanded: boolean;
  onToggle: () => void;
  activities: HealthWorkout[];
  onUpdateWeek: (weekIndex: number, entries: PlannedRunEntry[]) => void;
  /** Copy current week's entries to target week (replaces target). */
  onCopyWeekTo: (fromWeekIndex: number, toWeekIndex: number) => void;
  /** Copy a single day to another week/weekday. */
  onCopyDayToWeek: (
    fromWeekIndex: number,
    fromWeekday: number,
    toWeekIndex: number,
    toWeekday: number
  ) => void;
  /** Whether the plan-level edit mode is active. */
  isEditingPlan: boolean;
}

function WeekAccordion({
  plan,
  weekIndex,
  isExpanded,
  onToggle,
  activities,
  onUpdateWeek,
  onCopyWeekTo,
  onCopyDayToWeek,
  isEditingPlan,
}: WeekAccordionProps) {
  const week = plan.weeks[weekIndex];
  const [editingDay, setEditingDay] = useState<number | null>(null);

  // Drag-and-drop
  const [draggingDay, setDraggingDay] = useState<number | null>(null);
  const [dragOverDay, setDragOverDay] = useState<number | null>(null);
  const [swapConfirm, setSwapConfirm] = useState<{ from: number; to: number } | null>(null);

  // Copy day picker
  const [copyDaySource, setCopyDaySource] = useState<number | null>(null);
  const [copyDayTargetWeek, setCopyDayTargetWeek] = useState<number | null>(null);
  const [copyDayTargetWeekday, setCopyDayTargetWeekday] = useState<number | null>(null);
  const [copyDayOverwriteConfirm, setCopyDayOverwriteConfirm] = useState<{
    targetWeekIndex: number;
    targetWeekday: number;
  } | null>(null);

  // Copy week picker
  const [copyWeekOpen, setCopyWeekOpen] = useState(false);

  // Flash message
  const [flashText, setFlashText] = useState<string | null>(null);

  const matchResult = matchWeekRuns(plan, weekIndex, activities);
  const plannedMiles = weekPlannedMiles(week);
  const dateRange = weekDateRange(plan, weekIndex);

  const entries = [...(week.entries ?? [])].sort((a, b) => a.weekday - b.weekday);

  function showFlash(msg: string) {
    setFlashText(msg);
    setTimeout(() => setFlashText(null), 2000);
  }

  function saveEntry(updated: PlannedRunEntry) {
    const exists = entries.find((e) => e.id === updated.id);
    const newEntries = exists
      ? entries.map((e) => (e.id === updated.id ? updated : e))
      : [...entries, updated].sort((a, b) => a.weekday - b.weekday);
    onUpdateWeek(weekIndex, newEntries);
    setEditingDay(null);
  }

  function deleteEntry(entryId: string) {
    onUpdateWeek(weekIndex, entries.filter((e) => e.id !== entryId));
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────

  function handleMoveDay(fromWeekday: number, toWeekday: number) {
    if (fromWeekday === toWeekday) return;
    const fromEntry = entries.find((e) => e.weekday === fromWeekday);
    const toEntry = entries.find(
      (e) => e.weekday === toWeekday && e.runType !== "rest"
    );

    if (!fromEntry) return;

    if (!toEntry) {
      const next = entries
        .map((e) =>
          e.id === fromEntry.id
            ? { ...e, weekday: toWeekday, dayOfWeek: toWeekday - 1 }
            : e
        )
        .sort((a, b) => a.weekday - b.weekday);
      onUpdateWeek(weekIndex, next);
    } else {
      setSwapConfirm({ from: fromWeekday, to: toWeekday });
    }
  }

  function executeSwap(from: number, to: number) {
    const fromEntry = entries.find((e) => e.weekday === from);
    const toEntry = entries.find((e) => e.weekday === to && e.runType !== "rest");
    if (!fromEntry || !toEntry) return;

    const next = entries
      .map((e) => {
        if (e.id === fromEntry.id) return { ...e, weekday: to, dayOfWeek: to - 1 };
        if (e.id === toEntry.id) return { ...e, weekday: from, dayOfWeek: from - 1 };
        return e;
      })
      .sort((a, b) => a.weekday - b.weekday);
    onUpdateWeek(weekIndex, next);
    setSwapConfirm(null);
  }

  // ── Copy day ───────────────────────────────────────────────────────────

  function handleCopyDayConfirm() {
    if (
      copyDaySource == null ||
      copyDayTargetWeek == null ||
      copyDayTargetWeekday == null
    )
      return;

    const targetWeek = plan.weeks[copyDayTargetWeek];
    const existingTarget = targetWeek?.entries.find(
      (e) => e.weekday === copyDayTargetWeekday && e.runType !== "rest"
    );

    if (existingTarget) {
      setCopyDayOverwriteConfirm({
        targetWeekIndex: copyDayTargetWeek,
        targetWeekday: copyDayTargetWeekday,
      });
    } else {
      executeCopyDay(copyDaySource, copyDayTargetWeek, copyDayTargetWeekday);
    }
  }

  function executeCopyDay(
    sourceWeekday: number,
    targetWeekIndex: number,
    targetWeekday: number
  ) {
    onCopyDayToWeek(weekIndex, sourceWeekday, targetWeekIndex, targetWeekday);
    const weekNum = plan.weeks[targetWeekIndex]?.weekNumber ?? targetWeekIndex + 1;
    const dayLabel = DAY_SHORT[targetWeekday - 1] ?? String(targetWeekday);
    showFlash(`✓ Copied to Week ${weekNum} · ${dayLabel}`);
    setCopyDaySource(null);
    setCopyDayTargetWeek(null);
    setCopyDayTargetWeekday(null);
    setCopyDayOverwriteConfirm(null);
  }

  // ── Copy week ──────────────────────────────────────────────────────────

  function handleCopyWeekTo(targetWeekIndex: number) {
    onCopyWeekTo(weekIndex, targetWeekIndex);
    const targetWeekNum = plan.weeks[targetWeekIndex]?.weekNumber ?? targetWeekIndex + 1;
    showFlash(`✓ Week ${week.weekNumber} copied to Week ${targetWeekNum}`);
    setCopyWeekOpen(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-border overflow-hidden mb-3 bg-card">
      {/* Accordion header */}
      <div className="w-full flex items-center gap-3 px-4 py-3 bg-card hover:bg-surface transition-colors">
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-3 text-left"
        >
          <div className="flex-1">
            <span className="text-sm font-semibold text-textPrimary">
              Week {week.weekNumber}
            </span>
            <span className="ml-2 text-xs text-textSecondary">{dateRange}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-semibold text-textPrimary tabular-nums">
              {plannedMiles.toFixed(1)} mi
            </span>
            <WeekStatusBadge result={matchResult} />
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-textSecondary" />
            ) : (
              <ChevronDown className="w-4 h-4 text-textSecondary" />
            )}
          </div>
        </button>

        {/* Copy week button — edit mode only */}
        <div className="relative shrink-0 flex items-center gap-2">
          {flashText && (
            <span className="text-xs text-success font-medium whitespace-nowrap">
              {flashText}
            </span>
          )}
          {isEditingPlan && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setCopyWeekOpen((v) => !v);
              }}
              disabled={plan.weeks.length <= 1}
              title="Copy this week to another week"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Copy className="w-3 h-3" />
              Copy week →
            </button>
          )}
          {copyWeekOpen && plan.weeks.length > 1 && (
            <div className="absolute right-0 top-full mt-1 z-10 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px] max-h-64 overflow-y-auto">
              <div className="text-[10px] font-bold uppercase tracking-wide text-textSecondary px-3 py-1">
                Copy to week…
              </div>
              {plan.weeks.map((w, i) =>
                i === weekIndex ? null : (
                  <button
                    key={w.weekNumber}
                    onClick={() => handleCopyWeekTo(i)}
                    className="w-full text-left px-3 py-1.5 text-xs text-textPrimary hover:bg-surface flex items-center justify-between"
                  >
                    <span>Week {w.weekNumber}</span>
                    {w.entries.length > 0 && (
                      <span className="text-textSecondary text-[10px]">will overwrite</span>
                    )}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {/* Accordion body */}
      {isExpanded && (
        <div className="border-t border-border">
          {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
            const entry = entries.find(
              (e) => e.weekday === weekday && e.runType !== "rest"
            );
            const isEditing = editingDay === weekday;
            const isDragging = draggingDay === weekday;
            const isDragOver = dragOverDay === weekday;
            const date = dayDate(plan, weekIndex, weekday);
            const dateLabel = date.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });

            return (
              <div
                key={weekday}
                className={weekday < 7 ? "border-b border-border" : ""}
                draggable={!!entry && !isEditing && isEditingPlan}
                onDragStart={isEditingPlan ? (e) => {
                  if (!entry) return;
                  e.dataTransfer.setData("weekday", String(weekday));
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingDay(weekday);
                } : undefined}
                onDragOver={isEditingPlan ? (e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverDay(weekday);
                } : undefined}
                onDrop={isEditingPlan ? (e) => {
                  e.preventDefault();
                  const fromWeekday = parseInt(e.dataTransfer.getData("weekday"), 10);
                  if (!isNaN(fromWeekday)) handleMoveDay(fromWeekday, weekday);
                  setDraggingDay(null);
                  setDragOverDay(null);
                } : undefined}
                onDragEnd={isEditingPlan ? () => {
                  setDraggingDay(null);
                  setDragOverDay(null);
                } : undefined}
              >
                {/* Day row */}
                <div
                  className={`flex items-center gap-3 py-3 px-4 bg-card hover:bg-surface/50 group min-h-[52px] transition-all ${
                    isDragging ? "opacity-50" : ""
                  } ${isDragOver ? "ring-2 ring-inset ring-primary bg-primary/10" : ""}`}
                >
                  {/* Left: day + date */}
                  <div className="w-14 shrink-0">
                    <div className="text-xs font-bold text-textSecondary">
                      {DAY_ABBREVS[weekday - 1]}
                    </div>
                    <div className="text-xs text-textSecondary">{dateLabel}</div>
                  </div>

                  {isEditing ? (
                    <>
                      <div className="flex-1" />
                      <span className="text-sm text-textSecondary italic">
                        {entry ? "Editing…" : "Adding run…"}
                      </span>
                    </>
                  ) : !entry ? (
                    // Rest day
                    <>
                      <span className="text-sm text-textSecondary italic flex-1">
                        Rest
                      </span>
                      {isEditingPlan && (
                        <button
                          onClick={() => setEditingDay(weekday)}
                          className="text-xs text-primary hover:text-primary/80 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Plus className="w-3.5 h-3.5 inline mr-0.5" />
                          Add Run
                        </button>
                      )}
                    </>
                  ) : (
                    // Planned entry
                    <>
                      <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                        {entry.runType && entry.runType !== "rest" && (
                          <RunTypeBadge type={entry.runType} />
                        )}
                        {entry.description && (
                          <span className="text-sm text-textSecondary">
                            {entry.description}
                          </span>
                        )}
                        <span className="text-sm font-semibold text-textPrimary tabular-nums">
                          {entry.distanceMiles.toFixed(1)} mi
                        </span>
                        {entry.paceTarget && (
                          <span className="text-sm text-textSecondary">
                            @ {entry.paceTarget}/mi
                          </span>
                        )}
                        {entry.targetHeartRate && (
                          <span className="text-xs text-textSecondary">
                            HR: {entry.targetHeartRate} bpm
                          </span>
                        )}
                        {entry.notes && (
                          <span className="text-xs text-textSecondary italic">
                            {entry.notes}
                          </span>
                        )}
                      </div>
                      {isEditingPlan && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          {/* Copy day button */}
                          <button
                            onClick={() => {
                              setCopyDaySource(weekday);
                              setCopyDayTargetWeek(null);
                              setCopyDayTargetWeekday(null);
                            }}
                            className="text-[10px] text-textSecondary hover:text-primary border border-border rounded px-1.5 py-0.5 flex items-center gap-0.5"
                            title="Copy day to another week"
                          >
                            <Copy className="w-2.5 h-2.5" />
                            Copy
                          </button>
                          <button
                            onClick={() => setEditingDay(weekday)}
                            className="p-1 rounded hover:bg-border text-textSecondary hover:text-textPrimary"
                            title="Edit entry"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => deleteEntry(entry.id)}
                            className="p-1 rounded hover:bg-danger/10 text-textSecondary hover:text-danger"
                            title="Delete entry"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Inline entry form */}
                {isEditing && (
                  <div className="pb-2">
                    <EntryForm
                      initial={entry ?? {}}
                      weekday={weekday}
                      weekIndex={weekIndex}
                      onSave={saveEntry}
                      onCancel={() => setEditingDay(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Dialogs ── */}

      {/* Swap confirm */}
      <ConfirmDialog
        isOpen={swapConfirm !== null}
        title="Swap these two days?"
        message={
          swapConfirm
            ? `${DAY_SHORT[swapConfirm.from - 1]} and ${DAY_SHORT[swapConfirm.to - 1]} both have runs. Swap them?`
            : ""
        }
        confirmLabel="Swap"
        confirmVariant="primary"
        onConfirm={() => {
          if (swapConfirm) executeSwap(swapConfirm.from, swapConfirm.to);
        }}
        onCancel={() => setSwapConfirm(null)}
      />

      {/* Copy-day overwrite confirm */}
      <ConfirmDialog
        isOpen={copyDayOverwriteConfirm !== null}
        title="Overwrite existing run?"
        message={
          copyDayOverwriteConfirm
            ? `Week ${
                (plan.weeks[copyDayOverwriteConfirm.targetWeekIndex]?.weekNumber ??
                  copyDayOverwriteConfirm.targetWeekIndex + 1)
              } · ${DAY_SHORT[copyDayOverwriteConfirm.targetWeekday - 1]} already has a run. Overwrite it?`
            : ""
        }
        confirmLabel="Overwrite"
        confirmVariant="primary"
        onConfirm={() => {
          if (copyDaySource != null && copyDayOverwriteConfirm) {
            executeCopyDay(
              copyDaySource,
              copyDayOverwriteConfirm.targetWeekIndex,
              copyDayOverwriteConfirm.targetWeekday
            );
          }
        }}
        onCancel={() => setCopyDayOverwriteConfirm(null)}
      />

      {/* Copy-day picker modal */}
      {copyDaySource !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCopyDaySource(null);
              setCopyDayTargetWeek(null);
              setCopyDayTargetWeekday(null);
            }
          }}
        >
          <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-xs p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-textPrimary text-sm">
                Copy {DAY_SHORT[copyDaySource - 1]} to…
              </h3>
              <button
                onClick={() => {
                  setCopyDaySource(null);
                  setCopyDayTargetWeek(null);
                  setCopyDayTargetWeekday(null);
                }}
                className="p-1 rounded hover:bg-surface text-textSecondary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <label className="block text-xs font-semibold text-textSecondary mb-1.5">
              Week
            </label>
            <select
              value={copyDayTargetWeek ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setCopyDayTargetWeek(v === "" ? null : parseInt(v, 10));
                setCopyDayTargetWeekday(null);
              }}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-4"
            >
              <option value="">Select week…</option>
              {plan.weeks.map((w, i) => (
                <option key={i} value={i}>
                  Week {w.weekNumber}
                  {i === weekIndex ? " (current)" : ""}
                </option>
              ))}
            </select>

            {copyDayTargetWeek !== null && (
              <>
                <label className="block text-xs font-semibold text-textSecondary mb-1.5">
                  Day
                </label>
                <div className="grid grid-cols-7 gap-1 mb-4">
                  {[1, 2, 3, 4, 5, 6, 7].map((wd) => (
                    <button
                      key={wd}
                      onClick={() => setCopyDayTargetWeekday(wd)}
                      className={`py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        copyDayTargetWeekday === wd
                          ? "bg-primary text-white"
                          : "bg-surface text-textSecondary hover:bg-border"
                      }`}
                    >
                      {DAY_SHORT[wd - 1]}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setCopyDaySource(null);
                  setCopyDayTargetWeek(null);
                  setCopyDayTargetWeekday(null);
                }}
                className="px-4 py-2 rounded-xl border border-border text-sm text-textSecondary hover:bg-surface transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCopyDayConfirm}
                disabled={copyDayTargetWeek === null || copyDayTargetWeekday === null}
                className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function PlanEditPage() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useParams();
  const planId = typeof params.id === "string" ? params.id : null;

  const [isEditing, setIsEditing] = useState(false);
  const [plan, setPlan] = useState<RunningPlan | null>(null);
  const [activities, setActivities] = useState<HealthWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [notFound, setNotFound] = useState(false);

  // Inline name editing
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  // Accordion state
  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(new Set());

  // Copy plan modal
  const [copyPlanOpen, setCopyPlanOpen] = useState(false);
  const [copyPlanName, setCopyPlanName] = useState("");
  const [copyPlanSaving, setCopyPlanSaving] = useState(false);
  const [copyPlanFlash, setCopyPlanFlash] = useState<string | null>(null);

  const { showNavWarning, confirmNav, cancelNav, guardNavigation } =
    useUnsavedChanges(isEditing);

  useEffect(() => {
    if (!user || !planId) return;
    setLoading(true);
    Promise.all([
      fetchPlans(user.uid),
      fetchHealthWorkouts(user.uid, { limitCount: 500 }),
    ])
      .then(([plans, acts]) => {
        const found = plans.find((p) => p.id === planId);
        if (!found || !isRunningPlan(found)) {
          setNotFound(true);
          return;
        }
        setPlan(found);
        setNameInput(found.name);
        setActivities(acts);
        const idx = currentWeekIndex(found);
        setExpandedWeeks(new Set([idx]));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [user, planId]);

  function toggleWeek(idx: number) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleNameBlur() {
    if (!user || !plan) return;
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === plan.name) {
      setNameInput(plan.name);
      setEditingName(false);
      return;
    }
    const updated = { ...plan, name: trimmed };
    setPlan(updated);
    setEditingName(false);
    try {
      await updatePlan(user.uid, updated);
    } catch (e) {
      console.error(e);
    }
  }

  /** Update a single week's entries and autosave. */
  async function handleUpdateWeek(weekIndex: number, entries: PlannedRunEntry[]) {
    if (!user || !plan) return;
    const newWeeks = plan.weeks.map((w, i) =>
      i === weekIndex ? { ...w, entries } : w
    );
    const updated = { ...plan, weeks: newWeeks };
    setPlan(updated);
    try {
      await updatePlan(user.uid, updated);
    } catch (e) {
      console.error(e);
    }
  }

  /** Copy all entries from one week to another. */
  async function handleCopyWeek(fromWeekIndex: number, toWeekIndex: number) {
    if (!user || !plan) return;
    const sourceWeek = plan.weeks[fromWeekIndex];
    if (!sourceWeek) return;

    const copiedWeek = deepCopyRunWeek(sourceWeek, toWeekIndex);

    const newWeeks = plan.weeks.map((w, i) =>
      i === toWeekIndex ? { ...w, entries: copiedWeek.entries } : w
    );
    const updated = { ...plan, weeks: newWeeks };
    setPlan(updated);
    try {
      await updatePlan(user.uid, updated);
    } catch (e) {
      console.error(e);
    }
  }

  /** Copy a single day from one week/weekday to another week/weekday. */
  async function handleCopyDay(
    fromWeekIndex: number,
    fromWeekday: number,
    toWeekIndex: number,
    toWeekday: number
  ) {
    if (!user || !plan) return;
    const sourceWeek = plan.weeks[fromWeekIndex];
    const sourceEntry = sourceWeek?.entries.find(
      (e) => e.weekday === fromWeekday && e.runType !== "rest"
    );
    if (!sourceEntry) return;

    const copied = deepCopyRunEntry(sourceEntry, toWeekIndex, toWeekday);

    const newWeeks = plan.weeks.map((w, i) => {
      if (i !== toWeekIndex) return w;
      const filtered = w.entries.filter((e) => e.weekday !== toWeekday);
      return { ...w, entries: [...filtered, copied] };
    });
    const updated = { ...plan, weeks: newWeeks };
    setPlan(updated);
    try {
      await updatePlan(user.uid, updated);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleSaveAll() {
    if (!user || !plan || saving) return;
    setSaving(true);
    try {
      await updatePlan(user.uid, plan);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyPlan() {
    if (!user || !plan || copyPlanSaving) return;
    const name = copyPlanName.trim();
    if (!name) return;
    setCopyPlanSaving(true);
    try {
      const newPlan = await createPlan<RunningPlan>(
        user.uid,
        deepCopyRunningPlan(plan, name)
      );
      setCopyPlanOpen(false);
      setCopyPlanName("");
      setCopyPlanFlash(`✓ Copied as "${newPlan.name}"`);
      setTimeout(() => setCopyPlanFlash(null), 3000);
      router.push(`/plans/${newPlan.id}/edit`);
    } catch (e) {
      console.error(e);
    } finally {
      setCopyPlanSaving(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || !plan) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-textSecondary">Plan not found.</p>
        <button
          onClick={() => router.push("/plans")}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Plans
        </button>
      </div>
    );
  }

  const endDate = new Date(plan.startDate + "T00:00:00");
  endDate.setDate(endDate.getDate() + plan.weeks.length * 7 - 1);
  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-card border-b border-border">
        <div className="flex items-center gap-4 px-4 py-3 max-w-4xl mx-auto w-full">
          {/* Back */}
          <button
            onClick={() => guardNavigation(() => router.back())}
            className="text-sm text-textSecondary hover:text-textPrimary flex items-center gap-1 shrink-0"
          >
            ← Back to Plans
          </button>

          {/* Plan name (inline edit) */}
          <div className="flex-1 flex items-center justify-center min-w-0">
            {editingName ? (
              <input
                ref={nameRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") nameRef.current?.blur();
                  if (e.key === "Escape") {
                    setNameInput(plan.name);
                    setEditingName(false);
                  }
                }}
                className="text-sm font-semibold text-textPrimary bg-transparent border-b border-primary outline-none text-center w-full max-w-xs"
                autoFocus
              />
            ) : (
              <button
                onClick={() => setEditingName(true)}
                className="text-sm font-semibold text-textPrimary hover:text-primary truncate"
                title="Click to rename"
              >
                {plan.name}
              </button>
            )}
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-2 shrink-0">
            {copyPlanFlash && (
              <span className="text-xs text-success font-medium whitespace-nowrap">
                {copyPlanFlash}
              </span>
            )}
            {/* Edit / Done toggle */}
            <button
              onClick={() => setIsEditing((v) => !v)}
              className="text-sm px-3 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface"
            >
              {isEditing ? "Done" : "Edit"}
            </button>
            {/* Copy plan */}
            <button
              onClick={() => {
                setCopyPlanName(`${plan.name} (copy)`);
                setCopyPlanOpen(true);
              }}
              disabled={saving}
              title="Copy plan"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-50"
            >
              <Copy className="w-3 h-3" />
              Copy plan
            </button>
            {/* Save All */}
            <button
              onClick={handleSaveAll}
              disabled={saving}
              className="text-sm font-semibold text-primary hover:text-primary/80 disabled:opacity-50"
            >
              {savedFlash ? "Saved ✓" : saving ? "Saving…" : "Save All"}
            </button>
          </div>
        </div>
      </div>

      {/* Metadata bar */}
      <div className="border-b border-border bg-card">
        <div className="flex items-center gap-4 px-4 py-2 max-w-4xl mx-auto w-full text-xs text-textSecondary flex-wrap">
          <span>{fmtDate(new Date(plan.startDate + "T00:00:00"))}</span>
          <span className="text-border">·</span>
          <span>{fmtDate(endDate)}</span>
          <span className="text-border">·</span>
          <span>{plan.weeks.length} week{plan.weeks.length !== 1 ? "s" : ""}</span>
          <span className="text-border">·</span>
          <span
            className={`font-medium px-2 py-0.5 rounded-full ${
              plan.isActive
                ? "bg-success/10 text-success"
                : "bg-surface text-textSecondary"
            }`}
          >
            {plan.isActive ? "Active" : "Inactive"}
          </span>
        </div>
      </div>

      {/* Week accordions */}
      <div className="flex-1 p-4 max-w-4xl mx-auto w-full">
        {plan.weeks.map((_, idx) => (
          <WeekAccordion
            key={idx}
            plan={plan}
            weekIndex={idx}
            isExpanded={expandedWeeks.has(idx)}
            onToggle={() => toggleWeek(idx)}
            activities={activities}
            onUpdateWeek={handleUpdateWeek}
            onCopyWeekTo={handleCopyWeek}
            onCopyDayToWeek={handleCopyDay}
            isEditingPlan={isEditing}
          />
        ))}
      </div>

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

      {/* Copy plan modal */}
      {copyPlanOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !copyPlanSaving) setCopyPlanOpen(false);
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
