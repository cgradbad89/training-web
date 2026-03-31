"use client";

import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchPlans,
  createPlan,
  updatePlan,
  deletePlan,
  setActivePlan,
} from "@/services/plans";
import { fetchActivities } from "@/services/activities";
import { DEFAULT_HALF_MARATHON_PLAN } from "@/lib/seedData";
import {
  type RunningPlan,
  type PlannedRunEntry,
  type PlanWeek,
  type PlanRunType,
  type StravaActivity,
} from "@/types";
import {
  CheckCircle,
  Circle,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Check,
  X,
  AlertCircle,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute the calendar date of a plan entry */
function plannedDate(plan: RunningPlan, entry: PlannedRunEntry): Date {
  const [year, month, day] = plan.startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const daysOffset = entry.weekIndex * 7 + (entry.weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + daysOffset);
  return d;
}

/** Compute the calendar date of a specific weekday in a specific week */
function dayDate(plan: RunningPlan, weekIndex: number, weekday: number): Date {
  const [year, month, day] = plan.startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const offset = weekIndex * 7 + (weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + offset);
  return d;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function activityDate(a: StravaActivity): string {
  return a.start_date_local.split("T")[0];
}

/** Return ISO date string for next Monday from today */
function nextMonday(): string {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  const next = new Date(today);
  next.setDate(today.getDate() + daysUntilMonday);
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, "0");
  const d = String(next.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Return ISO date string for start + n weeks - 1 day (the Sunday of that week) */
function endDateForWeeks(startIso: string, weeks: number): string {
  const d = new Date(startIso + "T00:00:00");
  d.setDate(d.getDate() + weeks * 7 - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type MatchQuality = "full" | "partial";
interface PlanMatch {
  activity: StravaActivity;
  quality: MatchQuality;
}

/**
 * 4-pass plan vs actual matching (no type matching; per-week used-set).
 * Returns a map: entryId → PlanMatch | null
 */
function matchPlanToActual(
  plan: RunningPlan,
  activities: StravaActivity[]
): Map<string, PlanMatch | null> {
  const runs = activities.filter(
    (a) => a.type === "Run" || a.type === "TrailRun"
  );
  const result = new Map<string, PlanMatch | null>();

  function dateOf(e: PlannedRunEntry): string {
    return toISODate(plannedDate(plan, e));
  }
  function withinTolerance(e: PlannedRunEntry, a: StravaActivity): boolean {
    return (
      Math.abs(a.distance_miles - e.distanceMiles) <=
      Math.max(0.5, e.distanceMiles * 0.3)
    );
  }
  function withinOneDay(aDate: string, eDate: string): boolean {
    return (
      Math.abs(
        (new Date(aDate).getTime() - new Date(eDate).getTime()) / 86400000
      ) <= 1
    );
  }

  for (const week of plan.weeks) {
    const entries = week.entries.filter((e) => e.runType !== "rest");
    const used = new Set<number>();

    // Pass 1: exact day, distance within tolerance → "full"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = dateOf(e);
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (activityDate(a) !== eDate) continue;
        if (withinTolerance(e, a)) {
          result.set(e.id, { activity: a, quality: "full" });
          used.add(a.id);
          break;
        }
      }
    }

    // Pass 2: ±1 day, distance within tolerance → "full"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = dateOf(e);
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (!withinOneDay(activityDate(a), eDate)) continue;
        if (withinTolerance(e, a)) {
          result.set(e.id, { activity: a, quality: "full" });
          used.add(a.id);
          break;
        }
      }
    }

    // Pass 3: exact day, any distance → "partial"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = dateOf(e);
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (activityDate(a) !== eDate) continue;
        result.set(e.id, { activity: a, quality: "partial" });
        used.add(a.id);
        break;
      }
    }

    // Pass 4: ±1 day, any distance → "partial"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = dateOf(e);
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (!withinOneDay(activityDate(a), eDate)) continue;
        result.set(e.id, { activity: a, quality: "partial" });
        used.add(a.id);
        break;
      }
    }

    for (const e of entries) {
      if (!result.has(e.id)) result.set(e.id, null);
    }
  }

  return result;
}

// ─── Constants ────────────────────────────────────────────────────────────────

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

const WEEKDAY_LABELS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ─── Sub-components ───────────────────────────────────────────────────────────

function RunTypeBadge({ type }: { type: PlanRunType }) {
  const s = RUN_TYPE_STYLES[type];
  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}
    >
      {s.label}
    </span>
  );
}

// ─── Inline Day Editor ────────────────────────────────────────────────────────

interface InlineDayEditorProps {
  initial: Partial<PlannedRunEntry>;
  weekday: number; // fixed, 1–7
  weekIndex: number;
  onSave: (entry: PlannedRunEntry) => void;
  onCancel: () => void;
}

function InlineDayEditor({
  initial,
  weekday,
  weekIndex,
  onSave,
  onCancel,
}: InlineDayEditorProps) {
  const initRunType =
    initial.runType && initial.runType !== "rest"
      ? initial.runType
      : "outdoor";

  const [runType, setRunType] = useState<PlanRunType>(initRunType);
  const [description, setDescription] = useState(initial.description ?? "");
  const [distanceMiles, setDistanceMiles] = useState(
    initial.distanceMiles != null ? String(initial.distanceMiles) : ""
  );
  const [paceTarget, setPaceTarget] = useState(initial.paceTarget ?? "");
  const [targetHeartRate, setTargetHeartRate] = useState(
    initial.targetHeartRate != null ? String(initial.targetHeartRate) : ""
  );
  const [notes, setNotes] = useState(initial.notes ?? "");

  const RUN_TYPES: { value: PlanRunType; label: string }[] = [
    { value: "outdoor", label: "Outdoor" },
    { value: "treadmill", label: "Treadmill" },
    { value: "otf", label: "OTF" },
    { value: "longRun", label: "Long Run" },
  ];

  function handleSave() {
    const dist = parseFloat(distanceMiles);
    if (isNaN(dist) || dist <= 0) return;
    const hr = targetHeartRate ? parseInt(targetHeartRate, 10) : null;
    onSave({
      id: initial.id ?? crypto.randomUUID(),
      weekIndex,
      weekday,
      dayOfWeek: weekday - 1,
      distanceMiles: dist,
      runType,
      paceTarget: paceTarget.trim() || undefined,
      description: description.trim() || undefined,
      notes: notes.trim() || undefined,
      targetHeartRate: hr,
    });
  }

  return (
    <div className="p-3 rounded-xl border border-primary/30 bg-primary/5 mt-1 mb-1">
      {/* Run type segmented buttons */}
      <div className="flex rounded-lg border border-border overflow-hidden mb-3">
        {RUN_TYPES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setRunType(value)}
            className={`flex-1 py-1.5 text-xs font-semibold transition-colors ${
              runType === value
                ? "bg-primary text-white"
                : "text-textSecondary hover:bg-surface"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Fields row */}
      <div className="flex flex-wrap gap-2 items-center mb-2">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Easy effort"
          className="flex-1 min-w-[140px] text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={distanceMiles}
            onChange={(e) => setDistanceMiles(e.target.value)}
            placeholder="Dist"
            step="0.1"
            min="0"
            className="w-20 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
          />
          <span className="text-sm text-textSecondary">mi</span>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={paceTarget}
            onChange={(e) => setPaceTarget(e.target.value)}
            placeholder="M:SS"
            className="w-20 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
          />
          <span className="text-sm text-textSecondary">/mi</span>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={targetHeartRate}
            onChange={(e) => setTargetHeartRate(e.target.value)}
            placeholder="HR"
            min="0"
            max="250"
            className="w-16 text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
          />
          <span className="text-sm text-textSecondary">bpm</span>
        </div>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="flex-1 min-w-[120px] text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
        />
      </div>

      {/* Action row */}
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
          <Check className="w-3 h-3" /> Save
        </button>
      </div>
    </div>
  );
}

// ─── Week Summary Bar ─────────────────────────────────────────────────────────

function WeekSummaryBar({
  week,
  matchMap,
}: {
  week: PlanWeek;
  matchMap: Map<string, PlanMatch | null>;
}) {
  const runEntries = week.entries.filter((e) => e.runType !== "rest");
  const completedEntries = runEntries.filter((e) => matchMap.get(e.id));
  const plannedMiles = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
  const actualMiles = completedEntries.reduce((s, e) => {
    const m = matchMap.get(e.id);
    return s + (m ? m.activity.distance_miles : 0);
  }, 0);
  const pct = plannedMiles > 0 ? Math.min(actualMiles / plannedMiles, 1) : 0;

  return (
    <div className="mt-4 p-3 rounded-xl bg-surface border border-border">
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="text-textSecondary">
          {completedEntries.length} / {runEntries.length} runs ·{" "}
          {actualMiles.toFixed(1)} / {plannedMiles.toFixed(1)} mi
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
}

// ─── Modal wrapper ────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  onSave,
  saveLabel = "Save",
  children,
}: {
  title: string;
  onClose: () => void;
  onSave?: () => void;
  saveLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-card rounded-2xl shadow-xl w-full max-w-sm max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <button onClick={onClose} className="text-sm text-textSecondary">
            Cancel
          </button>
          <h3 className="text-sm font-semibold text-textPrimary">{title}</h3>
          {onSave ? (
            <button onClick={onSave} className="text-sm font-semibold text-primary">
              {saveLabel}
            </button>
          ) : (
            <div className="w-12" />
          )}
        </div>
        <div className="overflow-y-auto flex-1 p-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<RunningPlan[]>([]);
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  // editingDay: weekday (1–7) that has the inline editor open, null if none
  const [editingDay, setEditingDay] = useState<number | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [nameInput, setNameInput] = useState("");
  const [startDateInput, setStartDateInput] = useState("");
  const [endDateInput, setEndDateInput] = useState("");

  const weekTabsRef = useRef<HTMLDivElement>(null);

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;
  const matchMap = selectedPlan
    ? matchPlanToActual(selectedPlan, activities)
    : new Map<string, PlanMatch | null>();

  // All plans are fully editable — isBuiltInDefault no longer locks editing
  const isReadonly = false;

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!user) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function loadAll() {
    if (!user) return;
    setLoading(true);
    try {
      const [loadedPlans, loadedActivities] = await Promise.all([
        fetchPlans(user.uid),
        fetchActivities(),
      ]);

      let finalPlans = loadedPlans;
      if (loadedPlans.length === 0) {
        const seeded = await createPlan(user.uid, DEFAULT_HALF_MARATHON_PLAN);
        finalPlans = [seeded];
      }

      setPlans(finalPlans);
      setActivities(loadedActivities);

      const active = finalPlans.find((p) => p.isActive) ?? finalPlans[0];
      if (active) {
        setSelectedPlanId(active.id);
        setSelectedWeekIndex(currentWeekIndex(active));
      }
    } finally {
      setLoading(false);
    }
  }

  function currentWeekIndex(plan: RunningPlan): number {
    const start = new Date(plan.startDate + "T00:00:00");
    const today = new Date();
    const diff = Math.floor(
      (today.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000)
    );
    return Math.max(0, Math.min(diff, plan.weeks.length - 1));
  }

  // ── Plan-level actions ────────────────────────────────────────────────────

  async function handleSetActive(planId: string) {
    if (!user || saving) return;
    setSaving(true);
    try {
      await setActivePlan(user.uid, planId, plans);
      setPlans((prev) =>
        prev.map((p) => ({ ...p, isActive: p.id === planId }))
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    if (!user || !nameInput.trim() || !startDateInput || !endDateInput) return;
    const numWeeks = Math.max(
      1,
      Math.ceil(
        (new Date(endDateInput + "T00:00:00").getTime() -
          new Date(startDateInput + "T00:00:00").getTime()) /
          (7 * 86400000)
      )
    );
    setSaving(true);
    try {
      const plan = await createPlan(user.uid, {
        name: nameInput.trim(),
        startDate: startDateInput,
        isActive: false,
        weeks: Array.from({ length: numWeeks }, (_, i) => ({
          weekNumber: i + 1,
          entries: [],
        })),
      });
      setPlans((prev) => [...prev, plan]);
      setSelectedPlanId(plan.id);
      setSelectedWeekIndex(0);
      setMobileView("detail");
      setShowCreateModal(false);
      setNameInput("");
      setStartDateInput("");
      setEndDateInput("");
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    if (!user || !selectedPlan) return;
    setSaving(true);
    try {
      const plan = await createPlan(user.uid, {
        name: `${selectedPlan.name} (Copy)`,
        startDate: selectedPlan.startDate,
        isActive: false,
        isBuiltInDefault: false,
        weeks: JSON.parse(JSON.stringify(selectedPlan.weeks)) as PlanWeek[],
      });
      setPlans((prev) => [...prev, plan]);
      setSelectedPlanId(plan.id);
    } finally {
      setSaving(false);
    }
  }

  async function handleRename() {
    if (!user || !selectedPlan || !nameInput.trim()) return;
    setSaving(true);
    try {
      const updated = { ...selectedPlan, name: nameInput.trim() };
      await updatePlan(user.uid, updated);
      setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setShowRenameModal(false);
      setNameInput("");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!user || !selectedPlan) return;
    setSaving(true);
    try {
      await deletePlan(user.uid, selectedPlan.id);
      const remaining = plans.filter((p) => p.id !== selectedPlan.id);
      setPlans(remaining);
      setSelectedPlanId(remaining[0]?.id ?? null);
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  }

  // ── Entry-level actions ───────────────────────────────────────────────────

  async function saveEntryEdit(updated: PlannedRunEntry) {
    if (!user || !selectedPlan) return;
    const newWeeks = selectedPlan.weeks.map((w) => {
      if (w.weekNumber !== selectedWeekIndex + 1) return w;
      const exists = w.entries.find((e) => e.id === updated.id);
      return {
        ...w,
        entries: exists
          ? w.entries.map((e) => (e.id === updated.id ? updated : e))
          : [...w.entries, updated].sort((a, b) => a.weekday - b.weekday),
      };
    });
    const newPlan = { ...selectedPlan, weeks: newWeeks };
    await updatePlan(user.uid, newPlan);
    setPlans((prev) =>
      prev.map((p) => (p.id === newPlan.id ? newPlan : p))
    );
    setEditingDay(null);
  }

  async function handleDeleteEntry(entryId: string) {
    if (!user || !selectedPlan) return;
    const newWeeks = selectedPlan.weeks.map((w) => ({
      ...w,
      entries: w.entries.filter((e) => e.id !== entryId),
    }));
    const newPlan = { ...selectedPlan, weeks: newWeeks };
    await updatePlan(user.uid, newPlan);
    setPlans((prev) =>
      prev.map((p) => (p.id === newPlan.id ? newPlan : p))
    );
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const currentWeek: PlanWeek | undefined =
    selectedPlan?.weeks[selectedWeekIndex];

  const weekEntries = (currentWeek?.entries ?? [])
    .slice()
    .sort((a, b) => a.weekday - b.weekday);

  function weekDateRange(plan: RunningPlan, weekIdx: number): string {
    const start = new Date(plan.startDate + "T00:00:00");
    start.setDate(start.getDate() + weekIdx * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  function weekStats(plan: RunningPlan, week: PlanWeek) {
    const runEntries = week.entries.filter((e) => e.runType !== "rest");
    const completed = runEntries.filter((e) => matchMap.get(e.id)).length;
    const totalMiles = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
    return { completed, total: runEntries.length, totalMiles };
  }

  function openCreateModal() {
    const nm = nextMonday();
    setNameInput("");
    setStartDateInput(nm);
    setEndDateInput(endDateForWeeks(nm, 13));
    setShowCreateModal(true);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* ── Left Panel: Plan List ────────────────────────────────────────── */}
      <div className={`${mobileView === "detail" ? "hidden lg:flex" : "flex"} w-full lg:w-64 shrink-0 border-r border-border bg-card flex-col`}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-textPrimary">Plans</h2>
          <button
            onClick={openCreateModal}
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-primary"
            title="New plan"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {plans.map((plan) => (
            <button
              key={plan.id}
              onClick={() => {
                setSelectedPlanId(plan.id);
                setSelectedWeekIndex(currentWeekIndex(plan));
                setEditingDay(null);
                setMobileView("detail");
              }}
              className={`w-full text-left px-4 py-3 flex items-center gap-2 transition-colors ${
                selectedPlanId === plan.id
                  ? "bg-primary/10 text-primary"
                  : "text-textPrimary hover:bg-surface"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{plan.name}</div>
                <div className="text-xs text-textSecondary mt-0.5">
                  {plan.weeks.length} weeks
                  {plan.isBuiltInDefault && (
                    <span className="ml-1.5 text-warning">Template</span>
                  )}
                </div>
              </div>
              {plan.isActive && (
                <span
                  className="w-2 h-2 rounded-full bg-success shrink-0"
                  title="Active"
                />
              )}
              <ChevronRight className="w-4 h-4 shrink-0 text-textSecondary" />
            </button>
          ))}
        </div>
      </div>

      {/* ── Right Panel ─────────────────────────────────────────────────── */}
      <div className={`${mobileView === "list" ? "hidden lg:flex" : "flex"} flex-1 flex-col overflow-hidden`}>
        {selectedPlan ? (
          <>
            {/* Back button — mobile only */}
            <div className="lg:hidden px-6 pt-4 pb-0 bg-card border-b border-transparent">
              <button
                onClick={() => setMobileView("list")}
                className="text-sm text-primary mb-4 flex items-center gap-1"
              >
                ← Back to Plans
              </button>
            </div>

            {/* Plan header */}
            <div className="px-6 py-4 border-b border-border bg-card flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h1 className="text-lg font-bold text-textPrimary truncate">
                    {selectedPlan.name}
                  </h1>
                  {selectedPlan.isActive && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-sm text-textSecondary mt-0.5">
                  Starts{" "}
                  {new Date(
                    selectedPlan.startDate + "T00:00:00"
                  ).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  {" · "}
                  {selectedPlan.weeks.length} weeks
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!selectedPlan.isActive && (
                  <button
                    onClick={() => handleSetActive(selectedPlan.id)}
                    disabled={saving}
                    className="text-sm px-3 py-1.5 rounded-lg bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    Set Active
                  </button>
                )}
                <button
                  onClick={handleDuplicate}
                  disabled={saving}
                  title="Duplicate plan"
                  className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary disabled:opacity-50"
                >
                  <Copy className="w-4 h-4" />
                </button>
                <button
                  onClick={() => {
                    setNameInput(selectedPlan.name);
                    setShowRenameModal(true);
                  }}
                  disabled={saving}
                  title="Rename plan"
                  className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary disabled:opacity-50"
                >
                  <Pencil className="w-4 h-4" />
                </button>
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

            {/* Week tab strip */}
            <div
              ref={weekTabsRef}
              className="flex overflow-x-auto border-b border-border bg-card snap-x px-2"
              style={{ scrollbarWidth: "none" }}
            >
              {selectedPlan.weeks.map((week, idx) => {
                const stats = weekStats(selectedPlan, week);
                const isSelected = idx === selectedWeekIndex;
                return (
                  <button
                    key={idx}
                    onClick={() => {
                      setSelectedWeekIndex(idx);
                      setEditingDay(null);
                    }}
                    className={`shrink-0 snap-start px-4 py-3 flex flex-col items-center border-b-2 transition-colors ${
                      isSelected
                        ? "border-primary text-primary"
                        : "border-transparent text-textSecondary hover:text-textPrimary"
                    }`}
                  >
                    <span className="text-xs font-semibold whitespace-nowrap">
                      Wk {week.weekNumber}
                    </span>
                    <span className="text-xs mt-0.5 whitespace-nowrap">
                      {stats.totalMiles.toFixed(1)} mi
                    </span>
                    {stats.total > 0 && (
                      <span
                        className={`text-xs mt-0.5 ${
                          stats.completed === stats.total
                            ? "text-success"
                            : "text-textSecondary"
                        }`}
                      >
                        {stats.completed}/{stats.total}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Week content */}
            <div className="flex-1 overflow-y-auto">
              {currentWeek && (
                <div className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-textPrimary">
                        Week {currentWeek.weekNumber}
                      </h3>
                      <p className="text-xs text-textSecondary mt-0.5">
                        {weekDateRange(selectedPlan, selectedWeekIndex)}
                      </p>
                    </div>
                  </div>

                  {/* 7-day table */}
                  <div className="rounded-xl border border-border overflow-hidden">
                    {[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
                      const entry = weekEntries.find(
                        (e) => e.weekday === weekday && e.runType !== "rest"
                      );
                      const isEditing = editingDay === weekday;
                      const match = entry ? matchMap.get(entry.id) : undefined;
                      const date = dayDate(selectedPlan, selectedWeekIndex, weekday);
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const isPast = date < today;

                      // Status icon for this entry
                      let statusIcon: React.ReactNode = null;
                      if (entry) {
                        if (match?.quality === "full") {
                          statusIcon = <CheckCircle className="w-4 h-4 text-success shrink-0" />;
                        } else if (match?.quality === "partial") {
                          statusIcon = <Check className="w-4 h-4 text-warning shrink-0" />;
                        } else if (isPast) {
                          statusIcon = <AlertCircle className="w-4 h-4 text-danger shrink-0" />;
                        } else {
                          statusIcon = <Circle className="w-4 h-4 text-border shrink-0" />;
                        }
                      }

                      const dateLabel = date.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      });

                      return (
                        <div
                          key={weekday}
                          className={weekday < 7 ? "border-b border-border" : ""}
                        >
                          {/* Day row */}
                          <div className="flex items-center gap-3 py-3 px-3 hover:bg-surface/50 group min-h-[52px]">
                            {/* Left: day abbrev + date */}
                            <div className="w-14 shrink-0">
                              <div className="text-xs font-bold text-textSecondary">
                                {DAY_ABBREVS[weekday - 1]}
                              </div>
                              <div className="text-xs text-textSecondary">
                                {dateLabel}
                              </div>
                            </div>

                            {isEditing ? (
                              // Editing state — show placeholder
                              <>
                                <div className="w-4 shrink-0" />
                                <span className="text-sm text-textSecondary italic flex-1">
                                  {entry ? "Editing…" : "Adding run…"}
                                </span>
                              </>
                            ) : !entry ? (
                              // Rest state
                              <>
                                <div className="w-4 shrink-0" />
                                <span className="text-sm text-textSecondary italic flex-1">
                                  Rest
                                </span>
                                {!isReadonly && (
                                  <button
                                    onClick={() => setEditingDay(weekday)}
                                    className="text-xs text-primary hover:text-primary/80 opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    + Add Run
                                  </button>
                                )}
                              </>
                            ) : (
                              // Entry display state
                              <>
                                <div className="w-4 shrink-0">{statusIcon}</div>
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
                                  {match && (
                                    <span
                                      className={`text-xs ${
                                        match.quality === "full"
                                          ? "text-success"
                                          : "text-warning"
                                      }`}
                                    >
                                      {match.quality === "full" ? "✓" : "~"}{" "}
                                      {match.activity.distance_miles.toFixed(1)} mi ·{" "}
                                      {match.activity.pace_min_per_mile}/mi
                                    </span>
                                  )}
                                </div>
                                {!isReadonly && (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                    <button
                                      onClick={() => setEditingDay(weekday)}
                                      className="p-1 rounded hover:bg-border text-textSecondary hover:text-textPrimary"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleDeleteEntry(entry.id)}
                                      className="p-1 rounded hover:bg-red-100 text-textSecondary hover:text-danger"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>

                          {/* Inline editor (expands below the row) */}
                          {isEditing && (
                            <div className="px-3 pb-3">
                              <InlineDayEditor
                                initial={entry ?? {}}
                                weekday={weekday}
                                weekIndex={selectedWeekIndex}
                                onSave={(e) => saveEntryEdit(e)}
                                onCancel={() => setEditingDay(null)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {weekEntries.filter((e) => e.runType !== "rest").length > 0 && (
                    <WeekSummaryBar
                      week={currentWeek}
                      matchMap={matchMap}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-textSecondary mb-4">
                No training plan selected.
              </p>
              <button
                onClick={openCreateModal}
                className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary/90"
              >
                Create a plan
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────── */}

      {showCreateModal && (() => {
        const startD = startDateInput
          ? new Date(startDateInput + "T00:00:00")
          : null;
        const endD = endDateInput
          ? new Date(endDateInput + "T00:00:00")
          : null;
        const numWeeks =
          startD && endD && endD > startD
            ? Math.ceil(
                (endD.getTime() - startD.getTime()) / (7 * 86400000)
              )
            : null;
        const fmtDate = (d: Date) =>
          d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

        return (
          <Modal
            title="New Training Plan"
            onClose={() => setShowCreateModal(false)}
            onSave={handleCreate}
            saveLabel="Create"
          >
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-textPrimary block mb-1">
                  Plan Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="e.g. Fall Marathon 2026"
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm font-medium text-textPrimary block mb-1">
                  Start Date <span className="text-danger">*</span>
                </label>
                <input
                  type="date"
                  value={startDateInput}
                  onChange={(e) => setStartDateInput(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-textPrimary block mb-1">
                  End Date <span className="text-danger">*</span>
                </label>
                <input
                  type="date"
                  value={endDateInput}
                  onChange={(e) => setEndDateInput(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {numWeeks !== null && startD && endD && (
                  <p className="text-xs text-textSecondary mt-1">
                    {numWeeks} week{numWeeks !== 1 ? "s" : ""} (
                    {fmtDate(startD)} – {fmtDate(endD)})
                  </p>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}

      {showRenameModal && (
        <Modal
          title="Rename Plan"
          onClose={() => setShowRenameModal(false)}
          onSave={handleRename}
        >
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary"
            autoFocus
          />
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Delete Plan?"
          onClose={() => setConfirmDelete(false)}
          onSave={handleDelete}
          saveLabel="Delete"
        >
          <p className="text-sm text-textSecondary">
            Are you sure you want to delete{" "}
            <strong className="text-textPrimary">{selectedPlan?.name}</strong>?
            This cannot be undone.
          </p>
        </Modal>
      )}
    </div>
  );
}
