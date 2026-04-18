"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/hooks/useAuth";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import {
  fetchRaces,
  createRace,
  updateRace,
  deleteRace,
  setActiveRace,
} from "@/services/races";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  type Race,
  type RaceDistance,
  RACE_DISTANCE_MILES,
  RACE_DISTANCE_LABELS,
} from "@/types";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  formatPace,
  formatDuration,
  parsePaceString,
} from "@/utils/pace";
import {
  Calendar,
  MapPin,
  Plus,
  Pencil,
  Trash2,
  Trophy,
  X,
  Check,
  Star,
  Link,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysFromToday(dateStr: string): number {
  const race = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((race.getTime() - today.getTime()) / 86400000);
}

function raceMiles(race: Race): number {
  if (race.raceDistance === "custom") {
    return race.customDistanceMiles ?? 0;
  }
  return RACE_DISTANCE_MILES[race.raceDistance as Exclude<RaceDistance, "custom">];
}

function goalTime(paceSecPerMile: number, distanceMiles: number): string {
  if (!paceSecPerMile || !distanceMiles) return "—";
  const totalSeconds = paceSecPerMile * distanceMiles;
  return formatDuration(totalSeconds);
}

function formatRaceDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatActivityOption(a: HealthWorkout): string {
  const date = a.startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const pace = a.avgPaceSecPerMile
    ? `${Math.floor(a.avgPaceSecPerMile / 60)}:${String(Math.round(a.avgPaceSecPerMile % 60)).padStart(2, "0")}/mi`
    : "—";
  return `${date} · ${a.distanceMiles.toFixed(1)} mi · ${pace}`;
}

/** Workouts within ±30 days of the race date */
function nearbyRuns(
  activities: HealthWorkout[],
  raceDateStr: string
): HealthWorkout[] {
  const raceMs = new Date(raceDateStr + "T00:00:00").getTime();
  const window = 30 * 86400000;
  return activities.filter((a) => {
    if (!a.isRunLike) return false;
    const diff = Math.abs(a.startDate.getTime() - raceMs);
    return diff <= window;
  });
}

// ─── StatBlock ────────────────────────────────────────────────────────────────

function StatBlock({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-textSecondary">{label}</span>
      <span className="text-sm font-semibold text-textPrimary">{value}</span>
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-10 px-4">
      <Trophy className="w-8 h-8 text-border mx-auto mb-2" />
      <p className="text-sm text-textSecondary">{message}</p>
    </div>
  );
}

// ─── Race Card ────────────────────────────────────────────────────────────────

interface RaceCardProps {
  race: Race;
  linkedActivity?: HealthWorkout;
  isPast: boolean;
  onEdit: (race: Race) => void;
  onDelete: (race: Race) => void;
  onSetActive: (race: Race) => void;
}

function RaceCard({
  race,
  linkedActivity,
  isPast,
  onEdit,
  onDelete,
  onSetActive,
}: RaceCardProps) {
  const days = daysFromToday(race.raceDate);
  const miles = raceMiles(race);
  const distLabel = RACE_DISTANCE_LABELS[race.raceDistance];

  return (
    <div className="bg-card rounded-2xl border border-border shadow-[0_4px_8px_rgba(0,0,0,0.06)] p-5 flex flex-col gap-4">
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-textPrimary leading-snug">
          {race.name}
        </h3>
        {race.isActive && (
          <span className="shrink-0 flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success">
            <Star className="w-3 h-3" />
            Goal Race
          </span>
        )}
      </div>

      {/* Distance badge */}
      <div>
        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-primary/10 text-primary">
          {distLabel}
          {race.raceDistance === "custom" && race.customDistanceMiles
            ? ` (${race.customDistanceMiles} mi)`
            : ""}
        </span>
      </div>

      {/* Date row */}
      <div className="flex items-center gap-2 text-sm">
        <Calendar className="w-4 h-4 text-textSecondary shrink-0" />
        <span className="text-textPrimary">{formatRaceDate(race.raceDate)}</span>
        <span className="text-textSecondary">
          {isPast
            ? `(${Math.abs(days)} day${Math.abs(days) !== 1 ? "s" : ""} ago)`
            : `(${days} day${days !== 1 ? "s" : ""})`}
        </span>
      </div>

      {/* Location */}
      {race.location && (
        <div className="flex items-center gap-2 text-sm text-textSecondary">
          <MapPin className="w-4 h-4 shrink-0" />
          <span>{race.location}</span>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 py-3 border-t border-border">
        <StatBlock
          label="Target Pace"
          value={
            race.targetPaceSecondsPerMile
              ? `${formatPace(race.targetPaceSecondsPerMile)}/mi`
              : "—"
          }
        />
        <StatBlock
          label="Goal Time"
          value={
            race.targetPaceSecondsPerMile && miles
              ? goalTime(race.targetPaceSecondsPerMile, miles)
              : "—"
          }
        />
        <StatBlock
          label="Distance"
          value={miles ? `${miles.toFixed(miles < 10 ? 2 : 1)} mi` : "—"}
        />
      </div>

      {/* Past-race extras */}
      {isPast && (
        <div className="flex flex-col gap-2 pt-1 border-t border-border">
          {race.result ? (
            <div>
              <span className="text-xs text-textSecondary">Result</span>
              <p className="text-lg font-semibold text-primary">{race.result}</p>
            </div>
          ) : (
            <p className="text-sm text-textSecondary">No result recorded</p>
          )}

          {linkedActivity && (
            <div className="flex items-center gap-1.5 text-xs text-textSecondary">
              <Link className="w-3.5 h-3.5 text-primary" />
              <span className="text-primary font-medium">Linked run</span>
              <span>
                {linkedActivity.distanceMiles.toFixed(1)} mi ·{" "}
                {linkedActivity.avgPaceSecPerMile
                  ? `${Math.floor(linkedActivity.avgPaceSecPerMile / 60)}:${String(Math.round(linkedActivity.avgPaceSecPerMile % 60)).padStart(2, "0")}/mi`
                  : "—"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        {!isPast && (
          <button
            onClick={() => onSetActive(race)}
            disabled={race.isActive}
            className={`flex-1 text-sm py-1.5 rounded-lg font-medium transition-colors ${
              race.isActive
                ? "bg-success/10 text-success cursor-default"
                : "bg-surface border border-border text-textSecondary hover:bg-primary/10 hover:text-primary hover:border-primary/30"
            }`}
          >
            {race.isActive ? "Goal Race ✓" : "Set as Goal Race"}
          </button>
        )}
        <button
          onClick={() => onEdit(race)}
          className="p-2 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary"
          title="Edit"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={() => onDelete(race)}
          className="p-2 rounded-lg hover:bg-danger/10 text-textSecondary hover:text-danger"
          title="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Add/Edit Modal ───────────────────────────────────────────────────────────

const DISTANCE_OPTIONS: RaceDistance[] = [
  "5K",
  "10K",
  "halfMarathon",
  "marathon",
  "custom",
];

interface ModalFormState {
  name: string;
  raceDistance: RaceDistance;
  customDistanceMiles: string;
  raceDate: string;
  location: string;
  paceInput: string;         // "M:SS" string shown in UI
  linkedStravaActivityId: string;
  result: string;
  notes: string;
  setAsGoalRace: boolean;
}

function defaultForm(): ModalFormState {
  return {
    name: "",
    raceDistance: "halfMarathon",
    customDistanceMiles: "",
    raceDate: "",
    location: "",
    paceInput: "",
    linkedStravaActivityId: "",
    result: "",
    notes: "",
    setAsGoalRace: false,
  };
}

function raceToForm(race: Race): ModalFormState {
  return {
    name: race.name,
    raceDistance: race.raceDistance,
    customDistanceMiles: String(race.customDistanceMiles ?? ""),
    raceDate: race.raceDate,
    location: race.location ?? "",
    paceInput: race.targetPaceSecondsPerMile
      ? formatPace(race.targetPaceSecondsPerMile)
      : "",
    linkedStravaActivityId: race.linkedStravaActivityId ?? "",
    result: race.result ?? "",
    notes: race.notes ?? "",
    setAsGoalRace: race.isActive,
  };
}

interface RaceModalProps {
  editing: Race | null;
  activities: HealthWorkout[];
  onSave: (data: Omit<Race, "id" | "createdAt">, setGoal: boolean) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}

function RaceModal({ editing, activities, onSave, onClose, saving }: RaceModalProps) {
  const [form, setForm] = useState<ModalFormState>(
    editing ? raceToForm(editing) : defaultForm()
  );
  const [initialForm] = useState<ModalFormState>(
    editing ? raceToForm(editing) : defaultForm()
  );
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  useUnsavedChanges(isDirty);

  const parsedPace = parsePaceString(form.paceInput);
  const distMiles =
    form.raceDistance === "custom"
      ? parseFloat(form.customDistanceMiles) || 0
      : RACE_DISTANCE_MILES[form.raceDistance as Exclude<RaceDistance, "custom">];
  const previewGoalTime =
    parsedPace && distMiles ? goalTime(parsedPace, distMiles) : null;

  const nearbyActivities = form.raceDate
    ? nearbyRuns(activities, form.raceDate)
    : [];

  function set<K extends keyof ModalFormState>(key: K, val: ModalFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function valid(): boolean {
    if (!form.name.trim()) return false;
    if (!form.raceDate) return false;
    if (
      form.raceDistance === "custom" &&
      (parseFloat(form.customDistanceMiles) || 0) <= 0
    )
      return false;
    return true;
  }

  async function handleSubmit() {
    if (!valid()) return;
    const data: Omit<Race, "id" | "createdAt"> = {
      name: form.name.trim(),
      raceDate: form.raceDate,
      raceDistance: form.raceDistance,
      customDistanceMiles:
        form.raceDistance === "custom"
          ? parseFloat(form.customDistanceMiles)
          : undefined,
      location: form.location.trim() || undefined,
      targetPaceSecondsPerMile: parsedPace ?? undefined,
      linkedStravaActivityId: form.linkedStravaActivityId || undefined,
      result: form.result.trim() || undefined,
      notes: form.notes.trim() || undefined,
      isActive: editing ? editing.isActive : false,
    };
    await onSave(data, form.setAsGoalRace);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-hidden"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative z-10 bg-card rounded-2xl shadow-xl w-full max-w-[520px] flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10 shrink-0">
          <button onClick={onClose} className="text-sm text-textSecondary">
            Cancel
          </button>
          <h2 className="text-sm font-semibold text-textPrimary">
            {editing ? "Edit Race" : "Add Race"}
          </h2>
          <button
            onClick={handleSubmit}
            disabled={!valid() || saving}
            className="text-sm font-semibold text-primary disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-4 flex flex-col gap-4">
          {/* Race Name */}
          <Field label="Race Name" required>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. NYC Half Marathon"
              className="input"
              autoFocus
            />
          </Field>

          {/* Distance */}
          <Field label="Race Distance" required>
            <div className="flex gap-1.5 flex-wrap">
              {DISTANCE_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => set("raceDistance", d)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    form.raceDistance === d
                      ? "bg-primary text-white border-primary"
                      : "bg-surface border-border text-textSecondary hover:border-primary/40 hover:text-primary"
                  }`}
                >
                  {RACE_DISTANCE_LABELS[d]}
                </button>
              ))}
            </div>
            {form.raceDistance === "custom" && (
              <input
                type="number"
                value={form.customDistanceMiles}
                onChange={(e) => set("customDistanceMiles", e.target.value)}
                placeholder="Distance in miles"
                min="0"
                step="0.1"
                className="input mt-2"
              />
            )}
          </Field>

          {/* Date */}
          <Field label="Race Date" required>
            <input
              type="date"
              value={form.raceDate}
              onChange={(e) => set("raceDate", e.target.value)}
              className="input"
            />
          </Field>

          {/* Location */}
          <Field label="Location">
            <input
              type="text"
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              placeholder="e.g. New York, NY"
              className="input"
            />
          </Field>

          {/* Target Pace */}
          <Field
            label="Target Pace"
            hint="Goal finish time will be calculated"
          >
            <input
              type="text"
              value={form.paceInput}
              onChange={(e) => set("paceInput", e.target.value)}
              placeholder="M:SS (e.g. 9:45)"
              className="input"
            />
            {previewGoalTime && (
              <p className="mt-1 text-sm text-primary font-medium">
                = {previewGoalTime} finish time
              </p>
            )}
          </Field>

          {/* Link Workout */}
          <Field label="Link Workout">
            <select
              value={form.linkedStravaActivityId}
              onChange={(e) => set("linkedStravaActivityId", e.target.value)}
              className="input"
              disabled={!form.raceDate}
            >
              <option value="">None</option>
              {nearbyActivities.map((a) => (
                <option key={a.workoutId} value={a.workoutId}>
                  {formatActivityOption(a)}
                </option>
              ))}
            </select>
            {!form.raceDate && (
              <p className="mt-1 text-xs text-textSecondary">
                Set a race date to see nearby runs
              </p>
            )}
          </Field>

          {/* Result */}
          <Field label="Result" hint="Your official finish time">
            <input
              type="text"
              value={form.result}
              onChange={(e) => set("result", e.target.value)}
              placeholder="e.g. 2:10:45"
              className="input"
            />
          </Field>

          {/* Notes */}
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Any notes about this race…"
              rows={3}
              className="input resize-none"
            />
          </Field>

          {/* Set as Goal Race */}
          <div className="flex items-center justify-between py-2 px-3 rounded-xl bg-surface border border-border">
            <div>
              <p className="text-sm font-medium text-textPrimary">
                Set as Goal Race
              </p>
              <p className="text-xs text-textSecondary mt-0.5">
                This becomes your active target race
              </p>
            </div>
            <button
              onClick={() => set("setAsGoalRace", !form.setAsGoalRace)}
              className={`relative w-10 h-6 rounded-full transition-colors ${
                form.setAsGoalRace ? "bg-success" : "bg-border"
              }`}
            >
              {/* TODO: review for dark mode — bg-white toggle knob is intentional hardware-like design */}
            <span
                className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  form.setAsGoalRace ? "translate-x-5" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Footer — hidden; actions moved to sticky header */}
        <div className="hidden" />
      </div>
    </div>
  );
}

// ConfirmDelete replaced by shared ConfirmDialog

// ─── Field helper ─────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-textPrimary">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-textSecondary">{hint}</p>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RacesPage() {
  const { user } = useAuth();
  const [races, setRaces] = useState<Race[]>([]);
  const [activities, setActivities] = useState<HealthWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRace, setEditingRace] = useState<Race | null>(null);
  const [deletingRace, setDeletingRace] = useState<Race | null>(null);

  useEffect(() => {
    if (!user) return;
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    const isOpen = modalOpen || !!deletingRace;
    document.body.style.overflow = isOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [modalOpen, deletingRace]);

  async function loadAll() {
    if (!user) return;
    setLoading(true);
    try {
      const [loadedRaces, loadedActivities] = await Promise.all([
        fetchRaces(user.uid),
        fetchHealthWorkouts(user.uid, { limitCount: 200 }),
      ]);
      setRaces(loadedRaces);
      setActivities(loadedActivities);
    } finally {
      setLoading(false);
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcomingRaces = races
    .filter((r) => new Date(r.raceDate + "T00:00:00") >= today)
    .sort(
      (a, b) =>
        new Date(a.raceDate).getTime() - new Date(b.raceDate).getTime()
    );

  const pastRaces = races
    .filter((r) => new Date(r.raceDate + "T00:00:00") < today)
    .sort(
      (a, b) =>
        new Date(b.raceDate).getTime() - new Date(a.raceDate).getTime()
    );

  function linkedActivity(race: Race): HealthWorkout | undefined {
    if (!race.linkedStravaActivityId) return undefined;
    return activities.find(
      (a) => a.workoutId === race.linkedStravaActivityId
    );
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function openCreate() {
    setEditingRace(null);
    setModalOpen(true);
  }

  function openEdit(race: Race) {
    setEditingRace(race);
    setModalOpen(true);
  }

  async function handleSave(
    data: Omit<Race, "id" | "createdAt">,
    setGoal: boolean
  ) {
    if (!user) return;
    setSaving(true);
    try {
      if (editingRace) {
        await updateRace(user.uid, editingRace.id, data);
        if (setGoal && !editingRace.isActive) {
          await setActiveRace(user.uid, editingRace.id);
        }
      } else {
        const newId = await createRace(user.uid, data);
        if (setGoal) {
          await setActiveRace(user.uid, newId);
        }
      }
      setModalOpen(false);
      await loadAll();
    } finally {
      setSaving(false);
    }
  }

  async function handleSetActive(race: Race) {
    if (!user || saving) return;
    setSaving(true);
    try {
      await setActiveRace(user.uid, race.id);
      setRaces((prev) =>
        prev.map((r) => ({ ...r, isActive: r.id === race.id }))
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!user || !deletingRace) return;
    setSaving(true);
    try {
      await deleteRace(user.uid, deletingRace.id);
      setRaces((prev) => prev.filter((r) => r.id !== deletingRace.id));
      setDeletingRace(null);
    } finally {
      setSaving(false);
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

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <PageHeader
        title="Races"
        action={
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary/90"
          >
            <Plus className="w-4 h-4" />
            Add Race
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        {/* Upcoming */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
            Upcoming
          </h2>
          {upcomingRaces.length === 0 ? (
            <EmptyState message="No upcoming races. Add one to start tracking your goal." />
          ) : (
            <div className="flex flex-col gap-4">
              {upcomingRaces.map((race) => (
                <RaceCard
                  key={race.id}
                  race={race}
                  linkedActivity={linkedActivity(race)}
                  isPast={false}
                  onEdit={openEdit}
                  onDelete={setDeletingRace}
                  onSetActive={handleSetActive}
                />
              ))}
            </div>
          )}
        </section>

        {/* Past */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
            Past Races
          </h2>
          {pastRaces.length === 0 ? (
            <EmptyState message="Past races will appear here." />
          ) : (
            <div className="flex flex-col gap-4">
              {pastRaces.map((race) => (
                <RaceCard
                  key={race.id}
                  race={race}
                  linkedActivity={linkedActivity(race)}
                  isPast={true}
                  onEdit={openEdit}
                  onDelete={setDeletingRace}
                  onSetActive={handleSetActive}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Add/Edit modal */}
      {modalOpen && (
        <RaceModal
          editing={editingRace}
          activities={activities}
          onSave={handleSave}
          onClose={() => setModalOpen(false)}
          saving={saving}
        />
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        isOpen={!!deletingRace}
        title="Delete this race?"
        message="This will permanently remove the race and its goal data."
        confirmLabel="Delete Race"
        confirmVariant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeletingRace(null)}
        loading={saving}
      />
    </div>
  );
}
