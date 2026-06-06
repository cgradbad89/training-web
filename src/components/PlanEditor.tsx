"use client";

/**
 * Shared single-week-paginated plan editor.
 *
 * Renders the week navigation + 7-day grid + drag-to-move/swap + copy-day /
 * copy-week pickers that are common to every plan type. The TYPE-SPECIFIC bits
 * (how a day row reads, the inline entry form, what a blank entry looks like)
 * are injected via a config object — the component itself never branches on
 * planType inside its JSX.
 *
 * Persistence is NOT owned here: every mutation calls `onUpdateWeek(weekIndex,
 * entries)` and the caller writes to Firestore (preserving the existing
 * autosave-per-mutation model). Real dirty-state is surfaced via `onMarkDirty`
 * (a real mutation happened) and `onClearDirty` (cancel-with-no-change / exit).
 *
 * Currently wired by: CrossTrainingPlanDetail (workout plans). The running plan
 * is migrated in a later prompt.
 */

import React, { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Copy, X } from "lucide-react";

import type { Plan } from "@/types/plan";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  pageWeekIndex,
  clampWeekIndex,
  buildCopyWeekEntries,
  buildCopyDayEntries,
  resolveInitialWeekIndex,
  type WeekdayEntry,
} from "@/utils/planEditorLogic";

const DAY_ABBREVS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ─── Date helpers (shared) ────────────────────────────────────────────────────

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

/** Week containing today for active plans; week 1 for inactive/template plans. */
function defaultWeekForPlan(plan: Plan): number {
  if (plan.status !== "active") return 0;
  const start = new Date(plan.startDate + "T00:00:00");
  const today = new Date();
  const diff = Math.floor(
    (today.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000)
  );
  return Math.max(0, Math.min(diff, plan.weeks.length - 1));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Minimal entry shape the shared editor relies on. */
interface PlanEditorEntryBase extends WeekdayEntry {
  id: string;
  weekIndex: number;
  weekday: number;
  dayOfWeek: number;
}

export interface PlanEditorConfig<TEntry> {
  planType: "running" | "workout";
  /** Render a single day's read/edit row for one entry (type-specific fields). */
  renderEntryRow: (args: {
    entry: TEntry;
    isEditing: boolean;
    onEdit: () => void;
    onDelete: () => void;
    onCopyDay: () => void;
  }) => React.ReactNode;
  /**
   * Render the inline entry editor form (type-specific fields). `isNew` lets the
   * form gate first-save requirements (e.g. workout category) without leaking
   * editor state into the shared component.
   */
  renderEntryEditor: (args: {
    draft: TEntry;
    isNew: boolean;
    onSave: (updated: TEntry) => void;
    onCancel: () => void;
  }) => React.ReactNode;
  /** Factory for a new blank entry on a given weekday (1=Mon..7=Sun). */
  makeNewEntry: (weekIndex: number, weekday: number) => TEntry;
  /** Per-week summary label (e.g. "20.5 mi" running, "3 sessions" workout). */
  weekSummaryLabel: (entries: TEntry[]) => string;
  /**
   * Type-specific deep copy with fresh ids onto a target (weekIndex, weekday).
   * Required to keep copy-day / copy-week byte-for-byte identical to the legacy
   * per-type implementations (fresh nested ids, cleared completion, etc.).
   */
  copyEntryToDay: (
    entry: TEntry,
    targetWeekIndex: number,
    targetWeekday: number
  ) => TEntry;
  /** True for rest-placeholder entries (excluded from the day grid + copy). */
  isRest: (entry: TEntry) => boolean;
  /**
   * Optional per-week accessory rendered below the day grid (e.g. the running
   * completion progress bar). Omitted by the workout plan, keeping PlanEditor
   * free of type-specific concepts.
   */
  renderWeekAccessory?: (entries: TEntry[], weekIndex: number) => React.ReactNode;
}

export interface PlanEditorProps<TEntry> {
  plan: Plan;
  entriesForWeek: (weekIndex: number) => TEntry[];
  config: PlanEditorConfig<TEntry>;
  isEditMode: boolean;
  /** Edit/Done toggle is owned by the parent header; provided for API parity. */
  onToggleEdit: () => void;
  /** Caller persists: replace the given week's entries. */
  onUpdateWeek: (weekIndex: number, entries: TEntry[]) => void;
  /** A real mutation occurred. */
  onMarkDirty: () => void;
  /** Cancel-with-no-change, or exit of edit mode. */
  onClearDirty: () => void;
  /**
   * 0-based week to land on initially (e.g. a calendar deep-link target).
   * Overrides the default current-week landing; clamped to a valid index.
   */
  initialWeekIndex?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PlanEditor<TEntry extends PlanEditorEntryBase>({
  plan,
  entriesForWeek,
  config,
  isEditMode,
  onUpdateWeek,
  onMarkDirty,
  onClearDirty,
  initialWeekIndex,
}: PlanEditorProps<TEntry>) {
  const [selectedWeekIndex, setSelectedWeekIndex] = useState<number>(() =>
    resolveInitialWeekIndex(
      initialWeekIndex,
      defaultWeekForPlan(plan),
      plan.weeks.length
    )
  );

  // Editing state — null when no day is being edited. Either editing an existing
  // entry (entryId set) or adding a new one to a day (newEntry true).
  type EditingState =
    | { weekday: number; entryId: string; newEntry?: undefined }
    | { weekday: number; entryId?: undefined; newEntry: true };
  const [editingDay, setEditingDay] = useState<EditingState | null>(null);

  // Copy-week UI state
  const [copyWeekOpen, setCopyWeekOpen] = useState(false);
  const [copyFlashText, setCopyFlashText] = useState<string | null>(null);

  // Drag-and-drop state
  const [draggingDay, setDraggingDay] = useState<number | null>(null);
  const [dragOverDay, setDragOverDay] = useState<number | null>(null);
  const [swapConfirm, setSwapConfirm] = useState<{ from: number; to: number } | null>(
    null
  );

  // Copy-day state
  const [copyDaySource, setCopyDaySource] = useState<number | null>(null);
  const [copyDayTargetWeek, setCopyDayTargetWeek] = useState<number | null>(null);
  const [copyDayTargetWeekday, setCopyDayTargetWeekday] = useState<number | null>(
    null
  );
  const [copyDayOverwriteConfirm, setCopyDayOverwriteConfirm] = useState<{
    targetWeekIndex: number;
    targetWeekday: number;
  } | null>(null);

  // Leaving edit mode closes any open editor and clears the (real) dirty flag.
  useEffect(() => {
    if (!isEditMode) {
      setEditingDay(null);
      onClearDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode]);

  // If the plan shrinks (end-date shorten drops trailing weeks), clamp the
  // selected week so the pager never points past the last week.
  useEffect(() => {
    setSelectedWeekIndex((i) => clampWeekIndex(i, plan.weeks.length));
  }, [plan.weeks.length]);

  const weekCount = plan.weeks.length;
  const week = plan.weeks[selectedWeekIndex];
  const weekEntries = entriesForWeek(selectedWeekIndex);
  const sorted = [...weekEntries].sort((a, b) => a.weekday - b.weekday);
  const dateRange = weekDateRange(plan.startDate, selectedWeekIndex);
  const summaryLabel = config.weekSummaryLabel(weekEntries);

  // Type-specific noun for labels/dialogs (no planType branching in JSX below).
  const noun =
    config.planType === "workout"
      ? { cap: "Session", lower: "session", plural: "sessions" }
      : { cap: "Run", lower: "run", plural: "runs" };

  function showFlash(msg: string) {
    setCopyFlashText(msg);
    setTimeout(() => setCopyFlashText(null), 2000);
  }

  // ── Mutations (each marks dirty, then defers persistence to the caller) ────

  function commitWeek(weekIndex: number, entries: TEntry[]) {
    onMarkDirty();
    onUpdateWeek(weekIndex, entries);
  }

  function saveEntry(updated: TEntry) {
    const exists = sorted.find((e) => e.id === updated.id);
    const next = exists
      ? sorted.map((e) => (e.id === updated.id ? updated : e))
      : [...sorted, updated];
    commitWeek(
      selectedWeekIndex,
      next.slice().sort((a, b) => a.weekday - b.weekday)
    );
    setEditingDay(null);
  }

  function deleteEntry(id: string) {
    commitWeek(
      selectedWeekIndex,
      sorted.filter((e) => e.id !== id)
    );
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  function handleMoveDay(fromWeekday: number, toWeekday: number) {
    if (fromWeekday === toWeekday) return;
    const fromEntries = sorted.filter(
      (e) => e.weekday === fromWeekday && !config.isRest(e)
    );
    const toEntries = sorted.filter(
      (e) => e.weekday === toWeekday && !config.isRest(e)
    );
    if (fromEntries.length === 0) return;

    if (toEntries.length === 0) {
      const next = sorted
        .map((e) =>
          e.weekday === fromWeekday && !config.isRest(e)
            ? ({ ...e, weekday: toWeekday, dayOfWeek: toWeekday - 1 } as TEntry)
            : e
        )
        .sort((a, b) => a.weekday - b.weekday);
      commitWeek(selectedWeekIndex, next);
    } else {
      setSwapConfirm({ from: fromWeekday, to: toWeekday });
    }
  }

  function executeSwap(from: number, to: number) {
    const fromEntries = sorted.filter(
      (e) => e.weekday === from && !config.isRest(e)
    );
    const toEntries = sorted.filter((e) => e.weekday === to && !config.isRest(e));
    if (fromEntries.length === 0 || toEntries.length === 0) return;

    const next = sorted
      .map((e) => {
        if (config.isRest(e)) return e;
        if (e.weekday === from)
          return { ...e, weekday: to, dayOfWeek: to - 1 } as TEntry;
        if (e.weekday === to)
          return { ...e, weekday: from, dayOfWeek: from - 1 } as TEntry;
        return e;
      })
      .sort((a, b) => a.weekday - b.weekday);
    commitWeek(selectedWeekIndex, next);
    setSwapConfirm(null);
  }

  // ── Copy day ──────────────────────────────────────────────────────────────

  function openCopyDayPicker(sourceWeekday: number) {
    setCopyDaySource(sourceWeekday);
    setCopyDayTargetWeek(null);
    setCopyDayTargetWeekday(null);
  }

  function executeCopyDay(
    sourceWeekday: number,
    targetWeekIndex: number,
    targetWeekday: number
  ) {
    const sourceDayEntries = sorted.filter(
      (e) => e.weekday === sourceWeekday && !config.isRest(e)
    );
    if (sourceDayEntries.length === 0) return;

    const next = buildCopyDayEntries(
      entriesForWeek(targetWeekIndex),
      sourceDayEntries,
      targetWeekIndex,
      targetWeekday,
      config.copyEntryToDay,
      config.isRest
    );
    commitWeek(targetWeekIndex, next);

    const weekNum = plan.weeks[targetWeekIndex]?.weekNumber ?? targetWeekIndex + 1;
    const dayLabel = DAY_SHORT[targetWeekday - 1] ?? String(targetWeekday);
    showFlash(`✓ Copied to Week ${weekNum} · ${dayLabel}`);
    setCopyDaySource(null);
    setCopyDayTargetWeek(null);
    setCopyDayTargetWeekday(null);
  }

  function handleCopyDayConfirm() {
    if (
      copyDaySource == null ||
      copyDayTargetWeek == null ||
      copyDayTargetWeekday == null
    )
      return;

    const hasExistingTarget = entriesForWeek(copyDayTargetWeek).some(
      (e) => e.weekday === copyDayTargetWeekday && !config.isRest(e)
    );

    if (hasExistingTarget) {
      setCopyDayOverwriteConfirm({
        targetWeekIndex: copyDayTargetWeek,
        targetWeekday: copyDayTargetWeekday,
      });
    } else {
      executeCopyDay(copyDaySource, copyDayTargetWeek, copyDayTargetWeekday);
    }
  }

  // ── Copy week ─────────────────────────────────────────────────────────────

  function copyWeekTo(targetWeekIndex: number) {
    if (targetWeekIndex === selectedWeekIndex) return;
    if (targetWeekIndex < 0 || targetWeekIndex >= weekCount) return;

    const copiedEntries = buildCopyWeekEntries(
      sorted,
      targetWeekIndex,
      config.copyEntryToDay
    );
    commitWeek(targetWeekIndex, copiedEntries);

    const targetWeekNumber =
      plan.weeks[targetWeekIndex]?.weekNumber ?? targetWeekIndex + 1;
    showFlash(`✓ Copied to Week ${targetWeekNumber}`);
    setCopyWeekOpen(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Week navigation */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card gap-2">
        <button
          onClick={() => {
            setSelectedWeekIndex((i) => pageWeekIndex(i, -1, weekCount));
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
          {summaryLabel && (
            <div className="text-[11px] text-textSecondary mt-0.5">
              {summaryLabel}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 relative">
          {/* Copy week button — edit mode only */}
          {isEditMode && (
            <button
              onClick={() => setCopyWeekOpen((v) => !v)}
              disabled={weekCount <= 1}
              title={
                weekCount <= 1
                  ? "No other weeks to copy to"
                  : "Copy this week to another week"
              }
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Copy className="w-3 h-3" />
              Copy week →
            </button>
          )}
          {copyFlashText && (
            <span className="text-xs text-success font-medium ml-1 whitespace-nowrap">
              {copyFlashText}
            </span>
          )}
          {copyWeekOpen && weekCount > 1 && (
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
              setSelectedWeekIndex((i) => pageWeekIndex(i, 1, weekCount));
              setCopyWeekOpen(false);
            }}
            disabled={selectedWeekIndex >= weekCount - 1}
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
            const daySessions = sorted.filter(
              (e) => e.weekday === weekday && !config.isRest(e)
            );
            const hasSessions = daySessions.length > 0;
            const isMulti = daySessions.length > 1;
            const editingState =
              editingDay?.weekday === weekday ? editingDay : null;
            const isAddingNew = editingState?.newEntry === true;
            const isDragging = draggingDay === weekday;
            const isDragOver = dragOverDay === weekday;
            const date = dayDate(plan.startDate, selectedWeekIndex, weekday);
            const dateLabel = date.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });

            return (
              <div
                key={weekday}
                className={weekday < 7 ? "border-b border-border" : ""}
                draggable={hasSessions && !editingState && isEditMode}
                onDragStart={
                  isEditMode
                    ? (e) => {
                        if (!hasSessions) return;
                        e.dataTransfer.setData("weekday", String(weekday));
                        e.dataTransfer.effectAllowed = "move";
                        setDraggingDay(weekday);
                      }
                    : undefined
                }
                onDragOver={
                  isEditMode
                    ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDragOverDay(weekday);
                      }
                    : undefined
                }
                onDrop={
                  isEditMode
                    ? (e) => {
                        e.preventDefault();
                        const fromWeekday = parseInt(
                          e.dataTransfer.getData("weekday"),
                          10
                        );
                        if (!isNaN(fromWeekday))
                          handleMoveDay(fromWeekday, weekday);
                        setDraggingDay(null);
                        setDragOverDay(null);
                      }
                    : undefined
                }
                onDragEnd={
                  isEditMode
                    ? () => {
                        setDraggingDay(null);
                        setDragOverDay(null);
                      }
                    : undefined
                }
              >
                <div
                  className={`flex items-start gap-3 py-2 px-3 hover:bg-surface/50 group min-h-[52px] transition-all ${
                    isDragging ? "opacity-50" : ""
                  } ${
                    isDragOver ? "ring-2 ring-inset ring-primary bg-primary/10" : ""
                  }`}
                >
                  <div className="w-14 shrink-0 pt-1">
                    <div className="text-xs font-bold text-textSecondary">
                      {DAY_ABBREVS[weekday - 1]}
                    </div>
                    <div className="text-xs text-textSecondary">{dateLabel}</div>
                  </div>

                  {!hasSessions && !isAddingNew ? (
                    <>
                      <span className="text-sm text-textSecondary italic flex-1 pt-1">
                        Rest
                      </span>
                      {isEditMode && (
                        <button
                          onClick={() =>
                            setEditingDay({ weekday, newEntry: true })
                          }
                          className="text-xs text-primary hover:text-primary/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 pt-1"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add {noun.cap}
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex-1 min-w-0 flex flex-col gap-2 pt-0.5">
                      {daySessions.map((entry, idx) => {
                        const isThisEditing =
                          editingState?.entryId === entry.id;
                        if (isThisEditing) {
                          return (
                            <div
                              key={entry.id}
                              className="text-sm text-textSecondary italic"
                            >
                              {isMulti && (
                                <span className="text-[10px] font-bold uppercase tracking-wide text-textSecondary/80 mr-2">
                                  {noun.cap} {idx + 1}
                                </span>
                              )}
                              Editing…
                            </div>
                          );
                        }
                        return (
                          <div
                            key={entry.id}
                            className={
                              isMulti && idx > 0
                                ? "pt-2 border-t border-border/40"
                                : ""
                            }
                          >
                            {isMulti && (
                              <p className="text-[10px] font-bold uppercase tracking-wide text-textSecondary/80 mb-1">
                                {noun.cap} {idx + 1}
                              </p>
                            )}
                            {config.renderEntryRow({
                              entry,
                              isEditing: isEditMode,
                              onEdit: () =>
                                setEditingDay({ weekday, entryId: entry.id }),
                              onDelete: () => deleteEntry(entry.id),
                              onCopyDay: () => openCopyDayPicker(weekday),
                            })}
                          </div>
                        );
                      })}

                      {/* Add-another row — edit mode, when this day already has ≥1 */}
                      {isEditMode && hasSessions && !isAddingNew && (
                        <button
                          type="button"
                          onClick={() =>
                            setEditingDay({ weekday, newEntry: true })
                          }
                          className="self-start text-xs text-primary hover:text-primary/80 flex items-center gap-0.5 pt-1"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add {noun.cap}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {editingState && (
                  <div className="pb-2">
                    {config.renderEntryEditor({
                      draft: editingState.newEntry
                        ? config.makeNewEntry(selectedWeekIndex, weekday)
                        : daySessions.find(
                            (e) => e.id === editingState.entryId
                          ) ?? config.makeNewEntry(selectedWeekIndex, weekday),
                      isNew: !!editingState.newEntry,
                      onSave: saveEntry,
                      onCancel: () => setEditingDay(null),
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {config.renderWeekAccessory?.(weekEntries, selectedWeekIndex)}
      </div>

      {/* ── Dialogs ── */}

      {/* Swap confirm */}
      <ConfirmDialog
        isOpen={swapConfirm !== null}
        title="Swap these two days?"
        message={
          swapConfirm
            ? `${DAY_SHORT[swapConfirm.from - 1]} and ${
                DAY_SHORT[swapConfirm.to - 1]
              } both have ${noun.plural}. Swap them?`
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
        title={`Overwrite existing ${noun.lower}?`}
        message={
          copyDayOverwriteConfirm
            ? `Week ${
                plan.weeks[copyDayOverwriteConfirm.targetWeekIndex]?.weekNumber ??
                copyDayOverwriteConfirm.targetWeekIndex + 1
              } · ${
                DAY_SHORT[copyDayOverwriteConfirm.targetWeekday - 1]
              } already has a ${noun.lower}. Overwrite it?`
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
            setCopyDayOverwriteConfirm(null);
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

            {/* Step 1: pick week */}
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
                  {i === selectedWeekIndex ? " (current)" : ""}
                </option>
              ))}
            </select>

            {/* Step 2: pick weekday */}
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
                disabled={
                  copyDayTargetWeek === null || copyDayTargetWeekday === null
                }
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
