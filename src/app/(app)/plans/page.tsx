"use client";

import { useEffect, useState, useRef } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CrossTrainingPlanDetail } from "@/components/CrossTrainingPlanDetail";
import { RunningPlanDetail } from "@/components/RunningPlanDetail";
import { PlanExportModal } from "@/components/PlanExportModal";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchPlans,
  createPlan,
  updatePlan,
  deletePlan,
  setActivePlan,
  setPlanCompletion,
  nextStatusForSibling,
} from "@/services/plans";
import { deepCopyRunningPlan } from "@/utils/planCopy";
import {
  endDateForWeeks,
  weeksForSpan,
  copyPlanWithNewStart,
} from "@/utils/planDateEdit";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchRaces } from "@/services/races";
import { type Race } from "@/types/race";
import {
  DEFAULT_HALF_MARATHON_PLAN,
  seedSeptHMPlan,
  buildSeptTravelMigration,
} from "@/lib/seedData";
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
  groupPlansByStatus,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  matchPlanToActual,
  statusForRunEntry,
  type PlanMatch,
} from "@/utils/planMatching";
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
import { GoalsTab } from "@/components/GoalsTab";
import { useGoals } from "@/hooks/useGoals";

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

// endDateForWeeks + weeksForSpan are now sourced from src/utils/planDateEdit so
// the span math has a single tested source (see PRD §5 item 22).

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
      {plan.status === "active" && (
        <span
          className="w-2 h-2 rounded-full bg-success shrink-0"
          title="Active"
        />
      )}
      {plan.status === "completed" && (
        <Check className="w-3.5 h-3.5 shrink-0 text-textSecondary" aria-label="Completed" />
      )}
      <ChevronRight className="w-4 h-4 shrink-0 text-textSecondary" />
    </button>
  );
}

// ─── Sidebar plan-type group (with status sub-grouping) ──────────────────────

const STATUS_SUBGROUPS: { key: "active" | "draft" | "completed"; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "draft", label: "Draft" },
  { key: "completed", label: "Completed" },
];

/**
 * One plan-type section (Running / Workout) in the left bar. Within the section
 * plans are sub-grouped by status in fixed order (Active → Draft → Completed);
 * empty status buckets render no sub-header. Order within a bucket is the input
 * order (groupPlansByStatus preserves it).
 */
function PlanGroup({
  title,
  plans,
  emptyLabel,
  topBorder,
  selectedPlanId,
  onSelect,
}: {
  title: string;
  plans: Plan[];
  emptyLabel: string;
  topBorder?: boolean;
  selectedPlanId: string | null;
  onSelect: (plan: Plan) => void;
}) {
  const groups = groupPlansByStatus(plans);
  return (
    <>
      <div
        className={`px-4 pt-4 pb-2 ${topBorder ? "border-t border-border mt-2" : "pt-1"}`}
      >
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-textSecondary">
          {title}
        </h3>
      </div>
      {plans.length === 0 ? (
        <p className="px-4 pb-2 text-xs text-textSecondary italic">{emptyLabel}</p>
      ) : (
        STATUS_SUBGROUPS.map(({ key, label }) => {
          const bucket = groups[key];
          if (bucket.length === 0) return null;
          return (
            <div key={key}>
              <p className="px-4 pt-1.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-textSecondary/70">
                {label}
              </p>
              {bucket.map((plan) => (
                <SidebarPlanItem
                  key={plan.id}
                  plan={plan}
                  isSelected={selectedPlanId === plan.id}
                  onSelect={() => onSelect(plan)}
                />
              ))}
            </div>
          );
        })
      )}
    </>
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
  const [races, setRaces] = useState<Race[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [pageView, setPageView] = useState<"plans" | "calendar" | "goals">(
    "plans"
  );

  // Goals data — hook called unconditionally (before any early return).
  const {
    goals,
    loading: goalsLoading,
    refresh: refreshGoals,
  } = useGoals(user?.uid ?? null);

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

  // Calendar (.ics) export modal — lifted here since `plans` lives on the page.
  const [showExportModal, setShowExportModal] = useState(false);

  const weekTabsRef = useRef<HTMLDivElement>(null);

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;
  const selectedRunningPlan =
    selectedPlan && isRunningPlan(selectedPlan) ? selectedPlan : null;

  // Resolve the selected plan's linked race date (ISO) for the in-place date
  // editor's race-alignment note. Running links via linkedRaceId, workout via
  // raceId; both reference the single halfMarathonRaces collection. undefined
  // when there's no link or the race lacks a date → the note simply won't show.
  const selectedRaceId =
    selectedPlan && isRunningPlan(selectedPlan)
      ? selectedPlan.linkedRaceId
      : selectedPlan && isWorkoutPlan(selectedPlan)
        ? selectedPlan.raceId
        : undefined;
  const selectedRaceDate = selectedRaceId
    ? races.find((r) => r.id === selectedRaceId)?.raceDate
    : undefined;
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
      const [loadedPlans, loadedActivities, loadedRaces] = await Promise.all([
        fetchPlans(user.uid),
        fetchHealthWorkouts(user.uid),
        fetchRaces(user.uid),
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

      // One-time travel/run-reduction migration for the pre-existing live
      // Sept 2026 plan. Fresh seeds are already stamped, so they return null.
      try {
        const septPlan = finalPlans.find((p) =>
          p.name.toLowerCase().includes("sept 2026")
        );
        if (septPlan && isRunningPlan(septPlan)) {
          const migrated = buildSeptTravelMigration(septPlan);
          if (migrated) {
            await updatePlan(user.uid, migrated);
            finalPlans = finalPlans.map((p) =>
              p.id === migrated.id ? migrated : p
            );
          }
        }
      } catch (err) {
        console.error("[SeptTravelMigration] error", err);
      }

      setPlans(finalPlans);
      setActivities(loadedActivities);
      setRaces(loadedRaces);

      const active = finalPlans.find((p) => p.status === "active") ?? finalPlans[0];
      if (active) {
        setSelectedPlanId(active.id);
        setSelectedWeekIndex(currentWeekIndex(active));
      }
    } finally {
      setLoading(false);
    }
  }

  function currentWeekIndex(plan: Plan): number {
    // TEMP debug — confirms what fields the helper sees per plan. Remove
    // once both running and workout plans verified to land on the right week.
    // eslint-disable-next-line no-console
    console.log("[currentWeekIndex]", {
      name: plan.name,
      status: plan.status,
      startDate: plan.startDate,
      weeksLength: plan.weeks?.length,
    });
    // Inactive / template plans always open at Week 1 — users editing a
    // template or browsing an archived plan want to see the start, not a
    // computed "current week" that's meaningless for an unstarted plan.
    // Only active plans auto-jump to the week containing today's date.
    if (plan.status !== "active") return 0;
    const start = new Date(plan.startDate + "T00:00:00");
    const today = new Date();
    const diff = Math.floor(
      (today.getTime() - start.getTime()) / (7 * 24 * 3600 * 1000)
    );
    // Clamp: today before startDate → 0; today after last week → last week.
    return Math.max(0, Math.min(diff, plan.weeks.length - 1));
  }

  // ── Plan-level actions ────────────────────────────────────────────────────

  async function handleSetActive(planId: string) {
    if (!user || saving) return;
    setSaving(true);
    try {
      await setActivePlan(user.uid, planId, plans);
      // Mirror the service's same-type-only behaviour locally so a running
      // plan activation never flips the active workout plan's flag (and
      // vice versa). Plans of the other type keep their existing status. A
      // same-type "completed" sibling is left unchanged (not demoted), via
      // the same nextStatusForSibling rule the service uses.
      const target = plans.find((p) => p.id === planId);
      const targetIsRunning = !!target && isRunningPlan(target);
      const targetIsWorkout = !!target && isWorkoutPlan(target);
      setPlans((prev) =>
        prev.map((p) => {
          const sameType =
            (targetIsRunning && isRunningPlan(p)) ||
            (targetIsWorkout && isWorkoutPlan(p));
          if (!sameType) return p;
          const next = nextStatusForSibling(p, planId);
          if (!next) return p; // completed sibling — leave unchanged
          return { ...p, ...next };
        })
      );
    } finally {
      setSaving(false);
    }
  }

  // Completion is self-only: it clears this plan's own active flag and never
  // touches sibling plans (no auto-pick of a new active plan). setPlanCompletion
  // dual-writes status + completedAt + isActive together.
  async function handleCompletePlan(planId: string) {
    if (!user || saving) return;
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    setSaving(true);
    try {
      const merged = await setPlanCompletion(user.uid, plan, "complete");
      setPlans((prev) => prev.map((p) => (p.id === planId ? merged : p)));
    } finally {
      setSaving(false);
    }
  }

  async function handleReopenPlan(planId: string) {
    if (!user || saving) return;
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    setSaving(true);
    try {
      const merged = await setPlanCompletion(user.uid, plan, "reopen");
      setPlans((prev) => prev.map((p) => (p.id === planId ? merged : p)));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    if (!user || !nameInput.trim() || !startDateInput || !endDateInput) return;
    if (!pendingPlanType) return;
    const numWeeks = weeksForSpan(startDateInput, endDateInput);
    setSaving(true);
    try {
      let plan: Plan;
      if (pendingPlanType === "running") {
        plan = await createPlan<RunningPlan>(user.uid, {
          name: nameInput.trim(),
          planType: "running",
          startDate: startDateInput,
          status: "draft",
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
          status: "draft",
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

  async function handleCopyWorkoutPlan(newName: string, startIso: string) {
    if (!user || !selectedPlan || !isWorkoutPlan(selectedPlan)) return;
    const plan = await createPlan<WorkoutPlan>(
      user.uid,
      copyPlanWithNewStart(selectedPlan, newName, startIso) as Omit<
        WorkoutPlan,
        "id" | "createdAt" | "updatedAt"
      >
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

  /**
   * Persist updates to a Running plan from the in-place RunningPlanDetail.
   * Same autosave-per-mutation path as the legacy /edit route's handleUpdateWeek.
   */
  async function handleRunningPlanUpdate(updated: RunningPlan) {
    if (!user) return;
    setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    try {
      await updatePlan(user.uid, updated);
    } catch (e) {
      console.error(e);
    }
  }

  /** Copy the selected running plan under a given name (RunningPlanDetail modal). */
  async function handleCopyRunningPlanNamed(newName: string, startIso: string) {
    if (!user || !selectedPlan || !isRunningPlan(selectedPlan)) return;
    const plan = await createPlan<RunningPlan>(
      user.uid,
      copyPlanWithNewStart(selectedPlan, newName, startIso) as Omit<
        RunningPlan,
        "id" | "createdAt" | "updatedAt"
      >
    );
    setPlans((prev) => [...prev, plan]);
    setSelectedPlanId(plan.id);
    setCopyPlanFlash(`✓ Copied as "${plan.name}"`);
    setTimeout(() => setCopyPlanFlash(null), 3000);
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
        {(["plans", "calendar", "goals"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setPageView(v)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${
              pageView === v
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {v === "plans" ? "Plans" : v === "calendar" ? "Calendar" : "Goals"}
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
        />
      ) : pageView === "goals" ? (
        <GoalsTab
          uid={user?.uid ?? null}
          goals={goals}
          loading={goalsLoading}
          runs={activities}
          onChanged={refreshGoals}
        />
      ) : (
      <div className="flex flex-1 overflow-hidden">
      {/* ── Left Panel: Plan List ────────────────────────────────────────── */}
      <div className={`${mobileView === "detail" ? "hidden lg:flex" : "flex"} w-full lg:w-64 shrink-0 border-r border-border bg-card flex-col`}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-textPrimary">Plans &amp; Goals</h2>
          <button
            onClick={openTypePicker}
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-primary"
            title="New plan"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <PlanGroup
            title="Running Plans"
            plans={runningPlans}
            emptyLabel="No running plans"
            selectedPlanId={selectedPlanId}
            onSelect={(plan) => {
              setSelectedPlanId(plan.id);
              setSelectedWeekIndex(currentWeekIndex(plan));
              setMobileView("detail");
            }}
          />
          <PlanGroup
            title="Workout Plans"
            plans={workoutPlans}
            emptyLabel="No workout plans"
            topBorder
            selectedPlanId={selectedPlanId}
            onSelect={(plan) => {
              setSelectedPlanId(plan.id);
              setSelectedWeekIndex(currentWeekIndex(plan));
              setMobileView("detail");
            }}
          />
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
            key={selectedPlan.id}
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
            onComplete={() => handleCompletePlan(selectedPlan.id)}
            onReopen={() => handleReopenPlan(selectedPlan.id)}
            onCopyPlan={handleCopyWorkoutPlan}
            saving={saving}
            linkedRaceDate={selectedRaceDate}
            onExport={() => setShowExportModal(true)}
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

        {/* Running plan detail — in-place editor. Keyed by plan id + the
            page-level selected week so a calendar deep-link (which sets
            selectedWeekIndex) remounts onto its target week; normal in-editor
            pagination doesn't touch selectedWeekIndex, so it never remounts. */}
        {selectedRunningPlan ? (
          <RunningPlanDetail
            key={`${selectedRunningPlan.id}-${selectedWeekIndex}`}
            plan={selectedRunningPlan}
            activities={activities}
            initialWeekIndex={selectedWeekIndex}
            onUpdate={handleRunningPlanUpdate}
            onDelete={async () => {
              if (!user) return;
              setSaving(true);
              try {
                await deletePlan(user.uid, selectedRunningPlan.id);
                const remaining = plans.filter(
                  (p) => p.id !== selectedRunningPlan.id
                );
                setPlans(remaining);
                setSelectedPlanId(remaining[0]?.id ?? null);
              } finally {
                setSaving(false);
              }
            }}
            onSetActive={() => handleSetActive(selectedRunningPlan.id)}
            onComplete={() => handleCompletePlan(selectedRunningPlan.id)}
            onReopen={() => handleReopenPlan(selectedRunningPlan.id)}
            onCopyPlan={handleCopyRunningPlanNamed}
            onExport={() => setShowExportModal(true)}
            linkedRaceDate={selectedRaceDate}
          />
        ) : !selectedPlan ? (
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
        // Preserve the original display behavior: only show a count when the
        // end is strictly after the start (else null → hidden). The positive
        // branch matches weeksForSpan exactly for any end > start span.
        const numWeeks =
          startD && endD && endD > startD
            ? weeksForSpan(startDateInput, endDateInput)
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

      {/* Calendar (.ics) export modal — runningPlans already filtered above */}
      <PlanExportModal
        open={showExportModal}
        onClose={() => setShowExportModal(false)}
        allPlans={plans}
        initialPlanId={selectedPlanId ?? undefined}
      />

      {/* Copy plan success flash (running plans — shown in header area) */}
      {copyPlanFlash && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-success text-white text-sm font-medium px-4 py-2 rounded-xl shadow-lg">
          {copyPlanFlash}
        </div>
      )}
    </div>
  );
}
