"use client";

import { useEffect, useState, useRef } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CrossTrainingPlanDetail } from "@/components/CrossTrainingPlanDetail";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchPlans,
  createPlan,
  updatePlan,
  deletePlan,
  setActivePlan,
} from "@/services/plans";
import { deepCopyRunningPlan, deepCopyWorkoutPlan } from "@/utils/planCopy";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { DEFAULT_HALF_MARATHON_PLAN, seedSeptHMPlan } from "@/lib/seedData";
import {
  type Plan,
  type PlanType,
  type RunningPlan,
  type WorkoutPlan,
  type LegacyPilatesPlan,
  type PlannedRunEntry,
  type PlanWeek,
  type PlanRunType,
  isRunningPlan,
  isWorkoutPlan,
  isLegacyPilatesPlan,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { matchPlanToActual, type PlanMatch } from "@/utils/planMatching";
import { useRouter } from "next/navigation";
import {
  CheckCircle,
  Circle,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  Dumbbell,
  Footprints,
} from "lucide-react";
import { CalendarView } from "@/components/CalendarView";

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

function activityDate(a: HealthWorkout): string {
  return a.startDate.toISOString().split("T")[0];
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
    return s + (m ? m.activity.distanceMiles : 0);
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

// ─── Sidebar plan item ───────────────────────────────────────────────────────

function SidebarPlanItem({
  plan,
  isSelected,
  onSelect,
}: {
  plan: Plan;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isLegacy = isLegacyPilatesPlan(plan);
  const Icon = isWorkoutPlan(plan) || isLegacy ? Dumbbell : Footprints;
  const typeLabel = isWorkoutPlan(plan)
    ? "Workout"
    : isLegacy
      ? "Unsupported"
      : "Running";
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 flex items-center gap-2 transition-colors ${
        isSelected
          ? "bg-primary/10 text-primary"
          : "text-textPrimary hover:bg-surface"
      }`}
    >
      <Icon className="w-4 h-4 shrink-0 text-textSecondary" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{plan.name}</div>
        <div className="text-xs text-textSecondary mt-0.5">
          {plan.weeks.length} weeks · {typeLabel}
          {isRunningPlan(plan) && plan.isBuiltInDefault && (
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
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [activities, setActivities] = useState<HealthWorkout[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [pageView, setPageView] = useState<"plans" | "calendar">("plans");

  const [showTypePicker, setShowTypePicker] = useState(false);
  const [pendingPlanType, setPendingPlanType] = useState<PlanType | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [nameInput, setNameInput] = useState("");
  const [startDateInput, setStartDateInput] = useState("");
  const [endDateInput, setEndDateInput] = useState("");

  // Copy plan modal (running plans — workout plan copy is handled inside CrossTrainingPlanDetail)
  const [showCopyRunningPlanModal, setShowCopyRunningPlanModal] = useState(false);
  const [copyRunningPlanName, setCopyRunningPlanName] = useState("");
  const [copyPlanFlash, setCopyPlanFlash] = useState<string | null>(null);

  const weekTabsRef = useRef<HTMLDivElement>(null);

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;
  const selectedRunningPlan =
    selectedPlan && isRunningPlan(selectedPlan) ? selectedPlan : null;
  const matchMap = selectedRunningPlan
    ? matchPlanToActual(selectedRunningPlan, activities)
    : new Map<string, PlanMatch | null>();

  // Sidebar grouping — "Workout Plans" includes legacy pilates docs
  // so the user can see them and delete manually.
  const runningPlans = plans.filter(isRunningPlan);
  const workoutPlans = plans.filter(
    (p): p is WorkoutPlan | LegacyPilatesPlan =>
      isWorkoutPlan(p) || isLegacyPilatesPlan(p)
  );

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
        fetchHealthWorkouts(user.uid),
      ]);

      let finalPlans: Plan[] = loadedPlans;
      // Seed default running plan only if no plans of any kind exist
      if (loadedPlans.length === 0) {
        const seeded = await createPlan<RunningPlan>(
          user.uid,
          DEFAULT_HALF_MARATHON_PLAN
        );
        finalPlans = [seeded];
      }

      // One-time seed / replacement: September 2026 half marathon plan.
      //   • No "sept 2026" plan         → seed the current Sub 9:30 version
      //   • Existing plan has "sub 9:45" → delete the old one and reseed
      //   • Existing plan has "sub 9:30" → already up to date, skip
      const existingSept = finalPlans.find((p) =>
        p.name.toLowerCase().includes("sept 2026")
      );
      const isOldVersion =
        !!existingSept && existingSept.name.toLowerCase().includes("sub 9:45");
      const isCurrentVersion =
        !!existingSept && existingSept.name.toLowerCase().includes("sub 9:30");
      const needsSeed = !existingSept || isOldVersion;

      if (isOldVersion && existingSept) {
        try {
          await deletePlan(user.uid, existingSept.id);
          finalPlans = finalPlans.filter((p) => p.id !== existingSept.id);
        } catch (err) {
          console.error("[SeedSeptHMPlan] delete old plan error", err);
        }
      }

      if (needsSeed && !isCurrentVersion) {
        try {
          const { plan: septPlan } = await seedSeptHMPlan(user.uid);
          finalPlans = [...finalPlans, septPlan];
        } catch (err) {
          console.error("[SeedSeptHMPlan] error", err);
        }
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

  function currentWeekIndex(plan: Plan): number {
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
    if (!pendingPlanType) return;
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
      let plan: Plan;
      if (pendingPlanType === "running") {
        plan = await createPlan<RunningPlan>(user.uid, {
          name: nameInput.trim(),
          planType: "running",
          startDate: startDateInput,
          isActive: false,
          weeks: Array.from({ length: numWeeks }, (_, i) => ({
            weekNumber: i + 1,
            entries: [],
          })),
        });
      } else {
        plan = await createPlan<WorkoutPlan>(user.uid, {
          name: nameInput.trim(),
          planType: "workout",
          startDate: startDateInput,
          isActive: false,
          weeks: Array.from({ length: numWeeks }, (_, i) => ({
            weekNumber: i + 1,
            entries: [],
          })),
        });
      }
      setPlans((prev) => [...prev, plan]);
      setSelectedPlanId(plan.id);
      setSelectedWeekIndex(0);
      setMobileView("detail");
      setShowCreateModal(false);
      setPendingPlanType(null);
      setNameInput("");
      setStartDateInput("");
      setEndDateInput("");
    } finally {
      setSaving(false);
    }
  }

  function openCopyRunningPlanModal() {
    if (!selectedPlan || !isRunningPlan(selectedPlan)) return;
    setCopyRunningPlanName(`${selectedPlan.name} (copy)`);
    setShowCopyRunningPlanModal(true);
  }

  async function handleCopyRunningPlan() {
    if (!user || !selectedPlan || !isRunningPlan(selectedPlan)) return;
    const name = copyRunningPlanName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const plan = await createPlan<RunningPlan>(
        user.uid,
        deepCopyRunningPlan(selectedPlan, name)
      );
      setPlans((prev) => [...prev, plan]);
      setSelectedPlanId(plan.id);
      setShowCopyRunningPlanModal(false);
      setCopyRunningPlanName("");
      setCopyPlanFlash(`✓ Copied as "${plan.name}"`);
      setTimeout(() => setCopyPlanFlash(null), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyWorkoutPlan(newName: string) {
    if (!user || !selectedPlan || !isWorkoutPlan(selectedPlan)) return;
    const plan = await createPlan<WorkoutPlan>(
      user.uid,
      deepCopyWorkoutPlan(selectedPlan, newName)
    );
    setPlans((prev) => [...prev, plan]);
    setSelectedPlanId(plan.id);
    setCopyPlanFlash(`✓ Copied as "${plan.name}"`);
    setTimeout(() => setCopyPlanFlash(null), 3000);
  }

  /**
   * Persist updates to a Workout plan from CrossTrainingPlanDetail.
   * Optimistically updates local state, then writes through Firestore.
   */
  async function handleCrossTrainingUpdate(updated: WorkoutPlan) {
    if (!user) return;
    setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    try {
      await updatePlan(user.uid, updated);
    } catch (e) {
      console.error(e);
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


  // ── Derived (running plan only — polymorphic plans render via separate component) ──

  const currentWeek: PlanWeek | undefined =
    selectedRunningPlan?.weeks[selectedWeekIndex];

  const weekEntries = (currentWeek?.entries ?? [])
    .slice()
    .sort((a, b) => a.weekday - b.weekday);

  function weekDateRange(plan: Plan, weekIdx: number): string {
    const start = new Date(plan.startDate + "T00:00:00");
    start.setDate(start.getDate() + weekIdx * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  function weekStats(_plan: RunningPlan, week: PlanWeek) {
    const runEntries = week.entries.filter((e) => e.runType !== "rest");
    const completed = runEntries.filter((e) => matchMap.get(e.id)).length;
    const totalMiles = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
    return { completed, total: runEntries.length, totalMiles };
  }

  function openTypePicker() {
    setShowTypePicker(true);
  }

  function openCreateModalForType(type: PlanType) {
    const nm = nextMonday();
    const defaultWeeks = type === "running" ? 13 : 8;
    setPendingPlanType(type);
    setNameInput("");
    setStartDateInput(nm);
    setEndDateInput(endDateForWeeks(nm, defaultWeeks));
    setShowTypePicker(false);
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
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      {/* ── Tab toggle ──────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-b border-border bg-card shrink-0 flex items-center gap-2">
        {(["plans", "calendar"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setPageView(v)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${
              pageView === v
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {v === "plans" ? "Plans" : "Calendar"}
          </button>
        ))}
      </div>

      {pageView === "calendar" ? (
        <CalendarView
          plans={plans.filter(
            (p): p is RunningPlan | WorkoutPlan =>
              isRunningPlan(p) || isWorkoutPlan(p)
          )}
          actualRuns={activities}
          onRunningEventClick={(planId, weekIndex) => {
            setPageView("plans");
            setSelectedPlanId(planId);
            setSelectedWeekIndex(weekIndex);
            setMobileView("detail");
          }}
        />
      ) : (
      <div className="flex flex-1 overflow-hidden">
      {/* ── Left Panel: Plan List ────────────────────────────────────────── */}
      <div className={`${mobileView === "detail" ? "hidden lg:flex" : "flex"} w-full lg:w-64 shrink-0 border-r border-border bg-card flex-col`}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-textPrimary">Plans</h2>
          <button
            onClick={openTypePicker}
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-primary"
            title="New plan"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Running Plans group */}
          <div className="px-4 pt-1 pb-2">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-textSecondary">
              Running Plans
            </h3>
          </div>
          {runningPlans.length === 0 && (
            <p className="px-4 pb-2 text-xs text-textSecondary italic">
              No running plans
            </p>
          )}
          {runningPlans.map((plan) => (
            <SidebarPlanItem
              key={plan.id}
              plan={plan}
              isSelected={selectedPlanId === plan.id}
              onSelect={() => {
                setSelectedPlanId(plan.id);
                setSelectedWeekIndex(currentWeekIndex(plan));
                setMobileView("detail");
              }}
            />
          ))}

          {/* Workout Plans group */}
          <div className="px-4 pt-4 pb-2 border-t border-border mt-2">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-textSecondary">
              Workout Plans
            </h3>
          </div>
          {workoutPlans.length === 0 && (
            <p className="px-4 pb-2 text-xs text-textSecondary italic">
              No workout plans
            </p>
          )}
          {workoutPlans.map((plan) => (
            <SidebarPlanItem
              key={plan.id}
              plan={plan}
              isSelected={selectedPlanId === plan.id}
              onSelect={() => {
                setSelectedPlanId(plan.id);
                setSelectedWeekIndex(currentWeekIndex(plan));
                setMobileView("detail");
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Right Panel ─────────────────────────────────────────────────── */}
      <div className={`${mobileView === "list" ? "hidden lg:flex" : "flex"} flex-1 flex-col overflow-hidden`}>
        {/* Mobile back button (always available when a plan is selected) */}
        {selectedPlan && (
          <div className="lg:hidden px-6 pt-4 pb-0 bg-card border-b border-transparent">
            <button
              onClick={() => setMobileView("list")}
              className="text-sm text-primary mb-4 flex items-center gap-1"
            >
              ← Back to Plans
            </button>
          </div>
        )}

        {/* Workout plan detail */}
        {selectedPlan && isWorkoutPlan(selectedPlan) && (
          <CrossTrainingPlanDetail
            plan={selectedPlan}
            onUpdate={handleCrossTrainingUpdate}
            onDelete={async () => {
              if (!user) return;
              setSaving(true);
              try {
                await deletePlan(user.uid, selectedPlan.id);
                const remaining = plans.filter((p) => p.id !== selectedPlan.id);
                setPlans(remaining);
                setSelectedPlanId(remaining[0]?.id ?? null);
              } finally {
                setSaving(false);
              }
            }}
            onSetActive={() => handleSetActive(selectedPlan.id)}
            onCopyPlan={handleCopyWorkoutPlan}
            saving={saving}
          />
        )}

        {/* Orphaned legacy Pilates plan — unsupported message */}
        {selectedPlan && isLegacyPilatesPlan(selectedPlan) && (
          <div className="flex-1 flex flex-col">
            <div className="px-6 py-4 border-b border-border bg-card flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h1 className="text-lg font-bold text-textPrimary truncate">
                    {selectedPlan.name}
                  </h1>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                    Unsupported
                  </span>
                </div>
              </div>
              <button
                onClick={async () => {
                  if (!user) return;
                  setSaving(true);
                  try {
                    await deletePlan(user.uid, selectedPlan.id);
                    const remaining = plans.filter((p) => p.id !== selectedPlan.id);
                    setPlans(remaining);
                    setSelectedPlanId(remaining[0]?.id ?? null);
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
                className="p-1.5 rounded-lg hover:bg-red-50 text-textSecondary hover:text-danger disabled:opacity-50 shrink-0"
                title="Delete plan"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="max-w-md text-center">
                <AlertCircle className="w-10 h-10 text-warning mx-auto mb-3" />
                <p className="text-sm text-textPrimary font-medium mb-2">
                  This plan type is no longer supported
                </p>
                <p className="text-sm text-textSecondary">
                  Pilates plans have been merged into Workout plans. Please delete
                  this plan and recreate it as a Workout plan with duration-only
                  sessions.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Running plan detail (existing rendering) */}
        {selectedRunningPlan ? (() => {
          // Local alias so the existing JSX (which referenced `selectedPlan`)
          // continues to compile against the narrowed RunningPlan type.
          const selectedPlan: RunningPlan = selectedRunningPlan;
          return (
          <>
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
                  onClick={() => router.push(`/plans/${selectedPlan.id}/edit`)}
                  disabled={saving}
                  className="text-sm px-3 py-1.5 rounded-lg border border-border text-textPrimary font-medium hover:bg-surface disabled:opacity-50"
                >
                  Edit Plan
                </button>
                <button
                  onClick={openCopyRunningPlanModal}
                  disabled={saving}
                  title="Copy plan"
                  className="flex items-center gap-1 text-sm px-2.5 py-1.5 rounded-lg border border-border text-textSecondary hover:text-textPrimary hover:bg-surface disabled:opacity-50"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy plan
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
                          {/* Day row — read-only display */}
                          <div className="flex items-center gap-3 py-3 px-3 hover:bg-surface/50 min-h-[52px]">
                            {/* Left: day abbrev + date */}
                            <div className="w-14 shrink-0">
                              <div className="text-xs font-bold text-textSecondary">
                                {DAY_ABBREVS[weekday - 1]}
                              </div>
                              <div className="text-xs text-textSecondary">
                                {dateLabel}
                              </div>
                            </div>

                            {!entry ? (
                              // Rest state
                              <>
                                <div className="w-4 shrink-0" />
                                <span className="text-sm text-textSecondary italic flex-1">
                                  Rest
                                </span>
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
                                      {match.activity.distanceMiles.toFixed(1)} mi ·{" "}
                                      {match.activity.avgPaceSecPerMile
                                        ? `${Math.floor(match.activity.avgPaceSecPerMile / 60)}:${String(Math.round(match.activity.avgPaceSecPerMile % 60)).padStart(2, "0")}/mi`
                                        : "—"}
                                      {match.activity.avgHeartRate != null && (
                                        <span className="text-xs text-textSecondary ml-1">
                                          · {Math.round(match.activity.avgHeartRate)} bpm
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
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
          );
        })() : !selectedPlan ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-textSecondary mb-4">
                No training plan selected.
              </p>
              <button
                onClick={openTypePicker}
                className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary/90"
              >
                Create a plan
              </button>
            </div>
          </div>
        ) : null}
      </div>
      </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────── */}

      {/* Type picker — opened first when user clicks + */}
      {showTypePicker && (
        <Modal
          title="New Plan"
          onClose={() => setShowTypePicker(false)}
        >
          <p className="text-sm text-textSecondary mb-4">
            What kind of plan would you like to create?
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => openCreateModalForType("running")}
              className="flex items-center gap-3 p-3 rounded-xl border border-border hover:border-primary hover:bg-primary/5 transition-colors text-left"
            >
              <Footprints className="w-5 h-5 text-primary shrink-0" />
              <div>
                <div className="text-sm font-semibold text-textPrimary">
                  Running Plan
                </div>
                <div className="text-xs text-textSecondary">
                  Track planned runs with distance and pace
                </div>
              </div>
            </button>
            <button
              onClick={() => openCreateModalForType("workout")}
              className="flex items-center gap-3 p-3 rounded-xl border border-border hover:border-purple-400 hover:bg-purple-50 transition-colors text-left"
            >
              <Dumbbell className="w-5 h-5 text-purple-600 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-textPrimary">
                  Workout Plan
                </div>
                <div className="text-xs text-textSecondary">
                  Strength, HIIT, OTF, pilates, yoga — exercises or duration
                </div>
              </div>
            </button>
          </div>
        </Modal>
      )}

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
            title={
              pendingPlanType === "workout"
                ? "New Workout Plan"
                : "New Running Plan"
            }
            onClose={() => {
              setShowCreateModal(false);
              setPendingPlanType(null);
            }}
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
                  placeholder={
                    pendingPlanType === "workout"
                      ? "e.g. Off-season Strength"
                      : "e.g. Fall Marathon 2026"
                  }
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

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete this plan?"
        message="This will permanently delete the plan and all its workouts."
        confirmLabel="Delete Plan"
        confirmVariant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
        loading={saving}
      />

      {/* Copy running plan modal */}
      {showCopyRunningPlanModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) setShowCopyRunningPlanModal(false);
          }}
        >
          <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-xs p-5">
            <h3 className="font-bold text-textPrimary text-sm mb-4">Copy plan</h3>
            <label className="block text-xs font-semibold text-textSecondary mb-1.5">
              New plan name
            </label>
            <input
              type="text"
              value={copyRunningPlanName}
              onChange={(e) => setCopyRunningPlanName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCopyRunningPlan();
                if (e.key === "Escape" && !saving) setShowCopyRunningPlanModal(false);
              }}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCopyRunningPlanModal(false)}
                disabled={saving}
                className="px-4 py-2 rounded-xl border border-border text-sm text-textSecondary hover:bg-surface transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCopyRunningPlan()}
                disabled={!copyRunningPlanName.trim() || saving}
                className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                {saving ? "Copying…" : "Copy plan"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Copy plan success flash (running plans — shown in header area) */}
      {copyPlanFlash && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-success text-white text-sm font-medium px-4 py-2 rounded-xl shadow-lg">
          {copyPlanFlash}
        </div>
      )}
    </div>
  );
}
