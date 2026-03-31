"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Pencil, Trash2, Plus, X, Footprints, AlertCircle } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { fetchActivities } from "@/services/activities";
import {
  fetchShoes,
  createShoe,
  updateShoe,
  deleteShoe,
  fetchManualShoeAssignmentsMap,
  saveManualAssignments,
  batchAssignShoe,
} from "@/services/shoes";
import { isRun } from "@/utils/activityTypes";
import { formatPace } from "@/utils/pace";
import { type StravaActivity } from "@/types/activity";
import {
  type RunningShoe,
  type ShoeAutoAssignRule,
} from "@/types/shoe";

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOWN_GEAR_IDS: Record<string, { hint: string }> = {
  g29090468: { hint: "Detected in your run history" },
  g29090478: { hint: "Nike Flyknit (50 mi offset)" },
  g29489263: { hint: "Brooks Ghost 16" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shoeAssignedRuns(
  shoe: RunningShoe,
  activities: StravaActivity[],
  assignments: Record<string, string | null>
): StravaActivity[] {
  return activities.filter(
    (a) => isRun(a.type) && assignments[String(a.id)] === shoe.id
  );
}

function totalMileage(
  shoe: RunningShoe,
  activities: StravaActivity[],
  assignments: Record<string, string | null>
): number {
  const runs = shoeAssignedRuns(shoe, activities, assignments);
  return shoe.startMileageOffset + runs.reduce((s, r) => s + r.distance_miles, 0);
}

function mileageBarColor(pct: number): string {
  if (pct > 0.9) return "bg-danger";
  if (pct > 0.7) return "bg-warning";
  return "bg-success";
}

function buildRuleDescription(rule: ShoeAutoAssignRule, shoeName: string): string {
  const scopeText =
    rule.scope === "outdoor"
      ? "outdoor runs"
      : rule.scope === "treadmill"
      ? "treadmill runs"
      : "all runs";

  let distText = "";
  if (rule.minDistance != null && rule.maxDistance != null) {
    distText = ` between ${rule.minDistance}–${rule.maxDistance} miles`;
  } else if (rule.minDistance != null) {
    distText = ` over ${rule.minDistance} miles`;
  } else if (rule.maxDistance != null) {
    distText = ` under ${rule.maxDistance} miles`;
  }

  let dateText = "";
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (rule.startDate && rule.endDate) {
    dateText = ` from ${fmt(rule.startDate)} – ${fmt(rule.endDate)}`;
  } else if (rule.startDate) {
    dateText = ` from ${fmt(rule.startDate)}`;
  } else if (rule.endDate) {
    dateText = ` until ${fmt(rule.endDate)}`;
  }

  return `Assign ${shoeName} to ${scopeText}${distText}${dateText}`;
}

function newShoeDefaults(): Omit<RunningShoe, "id" | "addedAt"> {
  return {
    name: "",
    brand: "",
    model: "",
    colorway: "",
    stravaGearId: "",
    purchaseDate: "",
    startMileageOffset: 0,
    retirementMileageTarget: undefined,
    notes: "",
    isRetired: false,
    autoAssignRules: [],
  };
}

function newRuleDefaults(shoeId: string): ShoeAutoAssignRule {
  return {
    id: crypto.randomUUID(),
    shoeId,
    isEnabled: true,
    scope: "any",
    minDistance: undefined,
    maxDistance: undefined,
    startDate: undefined,
    endDate: undefined,
  };
}

// ─── Mileage Bar ─────────────────────────────────────────────────────────────

interface MileageBarProps {
  miles: number;
  target: number | undefined;
}

function MileageBar({ miles, target }: MileageBarProps) {
  if (!target) {
    return (
      <div>
        <div className="flex justify-between mb-1">
          <span className="text-sm font-semibold text-textPrimary tabular-nums">
            {miles.toFixed(1)} mi
          </span>
          <span className="text-xs text-textSecondary">No limit</span>
        </div>
        <div className="h-2 bg-surface rounded-full overflow-hidden border border-border">
          <div className="h-full bg-primary rounded-full" style={{ width: "60%" }} />
        </div>
      </div>
    );
  }

  const pct = Math.min(1, miles / target);
  const color = mileageBarColor(pct);

  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-sm font-semibold text-textPrimary tabular-nums">
          {miles.toFixed(1)} mi
        </span>
        <span className="text-xs text-textSecondary">{target} mi limit</span>
      </div>
      <div className="h-2 bg-surface rounded-full overflow-hidden border border-border">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

// ─── Shoe Card ────────────────────────────────────────────────────────────────

interface ShoeCardProps {
  shoe: RunningShoe;
  activities: StravaActivity[];
  assignments: Record<string, string | null>;
  onEdit: (shoe: RunningShoe) => void;
}

function ShoeCard({ shoe, activities, assignments, onEdit }: ShoeCardProps) {
  const assigned = shoeAssignedRuns(shoe, activities, assignments);
  const miles = totalMileage(shoe, activities, assignments);

  const totalTime = assigned.reduce((s, r) => s + r.moving_time_s, 0);
  const totalDist = assigned.reduce((s, r) => s + r.distance_miles, 0);
  const avgPaceSec = totalDist > 0 ? totalTime / totalDist : 0;

  const purchaseDateDisplay = shoe.purchaseDate
    ? new Date(shoe.purchaseDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5 flex flex-col gap-4">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Footprints size={16} className="text-textSecondary shrink-0" />
            <h3 className="text-lg font-semibold text-textPrimary leading-tight">{shoe.name}</h3>
          </div>
          {(shoe.brand || shoe.model) && (
            <p className="text-sm text-textSecondary mt-0.5">
              {[shoe.brand, shoe.model].filter(Boolean).join(" ")}
            </p>
          )}
          {shoe.stravaGearId && (
            <span className="inline-block mt-1 text-xs bg-surface border border-border text-textSecondary px-2 py-0.5 rounded-full">
              Strava: {shoe.stravaGearId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              shoe.isRetired
                ? "bg-gray-100 text-gray-500"
                : "bg-success/10 text-success"
            }`}
          >
            {shoe.isRetired ? "Retired" : "Active"}
          </span>
          <button
            onClick={() => onEdit(shoe)}
            aria-label="Edit shoe"
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary transition-colors"
          >
            <Pencil size={14} />
          </button>
        </div>
      </div>

      {/* Mileage bar */}
      <MileageBar miles={miles} target={shoe.retirementMileageTarget} />

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-border">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">Runs</span>
          <span className="text-base font-bold text-textPrimary tabular-nums">
            {assigned.length}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">Avg Pace</span>
          <span className="text-base font-bold text-textPrimary tabular-nums">
            {avgPaceSec > 0 ? `${formatPace(avgPaceSec)} /mi` : "—"}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">Purchased</span>
          <span className="text-base font-bold text-textPrimary">{purchaseDateDisplay}</span>
        </div>
      </div>

      {/* Footer */}
      <Link
        href={`/runs?shoe=${shoe.id}`}
        className="text-xs text-primary hover:underline"
      >
        View assigned runs →
      </Link>
    </div>
  );
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-[480px] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-textPrimary">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ─── Add/Edit Shoe Modal ──────────────────────────────────────────────────────

interface ShoeFormState {
  name: string;
  brand: string;
  model: string;
  stravaGearId: string;
  purchaseDate: string;
  startMileageOffset: string;
  retirementMileageTarget: string;
  notes: string;
  isRetired: boolean;
}

interface AddEditShoeModalProps {
  shoe: RunningShoe | null; // null = new shoe
  activities: StravaActivity[];
  existingShoes: RunningShoe[];
  onSave: (shoe: RunningShoe, isNew: boolean) => Promise<void>;
  onDelete: (shoe: RunningShoe) => void;
  onClose: () => void;
}

function AddEditShoeModal({
  shoe,
  activities,
  existingShoes,
  onSave,
  onDelete,
  onClose,
}: AddEditShoeModalProps) {
  const isNew = !shoe;

  const [form, setForm] = useState<ShoeFormState>(() => ({
    name: shoe?.name ?? "",
    brand: shoe?.brand ?? "",
    model: shoe?.model ?? "",
    stravaGearId: shoe?.stravaGearId ?? "",
    purchaseDate: shoe?.purchaseDate ?? "",
    startMileageOffset: String(shoe?.startMileageOffset ?? 0),
    retirementMileageTarget: shoe?.retirementMileageTarget != null
      ? String(shoe.retirementMileageTarget)
      : "",
    notes: shoe?.notes ?? "",
    isRetired: shoe?.isRetired ?? false,
  }));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Detect unlinked gear IDs from activity history
  const unlinkedGearIds = useMemo(() => {
    const linked = new Set(existingShoes.map((s) => s.stravaGearId).filter(Boolean));
    const found = new Set<string>();
    for (const a of activities) {
      if (a.gear_id && !linked.has(a.gear_id) && KNOWN_GEAR_IDS[a.gear_id]) {
        found.add(a.gear_id);
      }
    }
    return Array.from(found);
  }, [activities, existingShoes]);

  function set(field: keyof ShoeFormState, value: string | boolean) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) {
      setError("Shoe name is required.");
      return;
    }

    setSaving(true);
    try {
      const data: Omit<RunningShoe, "id" | "addedAt"> = {
        name: form.name.trim(),
        brand: form.brand.trim(),
        model: form.model.trim(),
        stravaGearId: form.stravaGearId.trim() || undefined,
        purchaseDate: form.purchaseDate || undefined,
        startMileageOffset: parseFloat(form.startMileageOffset) || 0,
        retirementMileageTarget: form.retirementMileageTarget
          ? parseFloat(form.retirementMileageTarget)
          : undefined,
        notes: form.notes.trim() || undefined,
        isRetired: form.isRetired,
        autoAssignRules: shoe?.autoAssignRules ?? [],
      };

      const full: RunningShoe = shoe
        ? { ...shoe, ...data }
        : { ...data, id: "", addedAt: "" }; // id/addedAt filled by createShoe

      await onSave(full, isNew);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const notesLen = form.notes.length;

  return (
    <Modal title={isNew ? "Add Shoe" : "Edit Shoe"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Unlinked gear ID hint — only on new shoe */}
        {isNew && unlinkedGearIds.length > 0 && (
          <div className="flex items-start gap-2 p-3 bg-primary/5 border border-primary/20 rounded-xl text-xs text-textSecondary">
            <AlertCircle size={14} className="text-primary shrink-0 mt-0.5" />
            <div>
              <span>Detected unlinked Strava gear: </span>
              {unlinkedGearIds.map((gid) => (
                <button
                  key={gid}
                  type="button"
                  onClick={() => set("stravaGearId", gid)}
                  className="font-mono text-primary hover:underline mr-1"
                >
                  {gid}
                </button>
              ))}
              <span className="text-textSecondary">
                {unlinkedGearIds.map((g) => KNOWN_GEAR_IDS[g]?.hint).filter(Boolean).join(", ")}
              </span>
            </div>
          </div>
        )}

        {/* Name */}
        <div>
          <label className="block text-xs font-semibold text-textSecondary mb-1">
            Shoe Name <span className="text-danger">*</span>
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Brooks Ghost 16"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Brand / Model */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">Brand</label>
            <input
              type="text"
              value={form.brand}
              onChange={(e) => set("brand", e.target.value)}
              placeholder="Brooks"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">Model</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="Ghost 16"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        {/* Purchase Date */}
        <div>
          <label className="block text-xs font-semibold text-textSecondary mb-1">
            Purchase Date
          </label>
          <input
            type="date"
            value={form.purchaseDate}
            onChange={(e) => set("purchaseDate", e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Start mileage / Retirement limit */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">
              Miles at Import
            </label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.startMileageOffset}
              onChange={(e) => set("startMileageOffset", e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-textSecondary mt-1">
              Existing mileage before tracking
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">
              Retire At (miles)
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={form.retirementMileageTarget}
              onChange={(e) => set("retirementMileageTarget", e.target.value)}
              placeholder="e.g. 400"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        {/* Strava Gear ID */}
        <div>
          <label className="block text-xs font-semibold text-textSecondary mb-1">
            Strava Gear ID
          </label>
          <input
            type="text"
            value={form.stravaGearId}
            onChange={(e) => set("stravaGearId", e.target.value)}
            placeholder="e.g. g29090478"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <p className="text-xs text-textSecondary mt-1">
            Found in Strava gear settings. Used for backfill matching.
          </p>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-semibold text-textSecondary mb-1">Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value.slice(0, 200))}
            rows={3}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary resize-none"
          />
          <p className="text-xs text-textSecondary mt-1 text-right">{notesLen}/200</p>
        </div>

        {/* Retired toggle */}
        <div className="flex items-center justify-between py-1">
          <span className="text-sm text-textPrimary">Mark as Retired</span>
          <button
            type="button"
            onClick={() => set("isRetired", !form.isRetired)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
              ${form.isRetired ? "bg-gray-400" : "bg-primary"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform
                ${form.isRetired ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {error && (
          <p className="text-sm text-danger">{error}</p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          {!isNew ? (
            <button
              type="button"
              onClick={() => onDelete(shoe!)}
              className="flex items-center gap-1.5 text-sm text-danger hover:text-danger/80 transition-colors"
            >
              <Trash2 size={14} />
              Delete
            </button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ─── Backfill Modal ───────────────────────────────────────────────────────────

interface BackfillModalProps {
  shoe: RunningShoe;
  unassignedMatches: StravaActivity[];
  onConfirm: () => Promise<void>;
  onSkip: () => void;
}

function BackfillModal({ shoe, unassignedMatches, onConfirm, onSkip }: BackfillModalProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title="Apply to Past Runs?" onClose={onSkip}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-textPrimary">
          <span className="font-semibold">{shoe.name}</span> has Strava gear ID{" "}
          <span className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded border border-border">
            {shoe.stravaGearId}
          </span>
          .{" "}
          <span className="font-semibold text-primary">
            {unassignedMatches.length} run
            {unassignedMatches.length !== 1 ? "s" : ""}
          </span>{" "}
          in your history have this gear ID and no manual assignment.
        </p>
        <p className="text-sm text-textSecondary">
          Assign them to <span className="font-medium text-textPrimary">{shoe.name}</span> now?
        </p>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <button
            onClick={onSkip}
            className="px-4 py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? "Assigning…" : `Assign ${unassignedMatches.length} Run${unassignedMatches.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Add/Edit Rule Modal ──────────────────────────────────────────────────────

interface RuleFormState {
  shoeId: string;
  scope: "any" | "outdoor" | "treadmill";
  minDistance: string;
  maxDistance: string;
  startDate: string;
  endDate: string;
  isEnabled: boolean;
}

interface AddEditRuleModalProps {
  rule: ShoeAutoAssignRule | null;
  targetShoe: RunningShoe | null; // pre-selected shoe when editing
  activeShoes: RunningShoe[];
  onSave: (rule: ShoeAutoAssignRule) => Promise<void>;
  onClose: () => void;
}

function AddEditRuleModal({
  rule,
  targetShoe,
  activeShoes,
  onSave,
  onClose,
}: AddEditRuleModalProps) {
  const isNew = !rule;

  const [form, setForm] = useState<RuleFormState>(() => ({
    shoeId: rule?.shoeId ?? targetShoe?.id ?? activeShoes[0]?.id ?? "",
    scope: rule?.scope ?? "any",
    minDistance: rule?.minDistance != null ? String(rule.minDistance) : "",
    maxDistance: rule?.maxDistance != null ? String(rule.maxDistance) : "",
    startDate: rule?.startDate ?? "",
    endDate: rule?.endDate ?? "",
    isEnabled: rule?.isEnabled ?? true,
  }));

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function set<K extends keyof RuleFormState>(field: K, value: RuleFormState[K]) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!form.shoeId) { setError("Shoe is required."); return; }
    const min = form.minDistance ? parseFloat(form.minDistance) : undefined;
    const max = form.maxDistance ? parseFloat(form.maxDistance) : undefined;
    if (min != null && max != null && min >= max) {
      setError("Min distance must be less than max distance."); return;
    }
    if (form.startDate && form.endDate && form.startDate > form.endDate) {
      setError("Start date must be before end date."); return;
    }

    setSaving(true);
    try {
      const built: ShoeAutoAssignRule = {
        id: rule?.id ?? crypto.randomUUID(),
        shoeId: form.shoeId,
        isEnabled: form.isEnabled,
        scope: form.scope,
        minDistance: min,
        maxDistance: max,
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
      };
      await onSave(built);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const SCOPES: { value: RuleFormState["scope"]; label: string }[] = [
    { value: "any", label: "All Runs" },
    { value: "outdoor", label: "Outdoor Only" },
    { value: "treadmill", label: "Treadmill Only" },
  ];

  return (
    <Modal title={isNew ? "Add Rule" : "Edit Rule"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Shoe */}
        <div>
          <label className="block text-xs font-semibold text-textSecondary mb-1">
            Shoe <span className="text-danger">*</span>
          </label>
          <select
            value={form.shoeId}
            onChange={(e) => set("shoeId", e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">Select shoe…</option>
            {activeShoes.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Scope */}
        <div>
          <label className="block text-xs font-semibold text-textSecondary mb-1">
            Workout Scope
          </label>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {SCOPES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => set("scope", value)}
                className={`flex-1 py-2 text-xs font-semibold transition-colors
                  ${form.scope === value
                    ? "bg-primary text-white"
                    : "text-textSecondary hover:bg-surface"
                  }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Distance range */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">
              Min Distance (mi)
            </label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.minDistance}
              onChange={(e) => set("minDistance", e.target.value)}
              placeholder="Optional"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">
              Max Distance (mi)
            </label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.maxDistance}
              onChange={(e) => set("maxDistance", e.target.value)}
              placeholder="Optional"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">
              Start Date
            </label>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => set("startDate", e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-textSecondary mb-1">
              End Date
            </label>
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => set("endDate", e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center justify-between py-1">
          <span className="text-sm text-textPrimary">Enabled</span>
          <button
            type="button"
            onClick={() => set("isEnabled", !form.isEnabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
              ${form.isEnabled ? "bg-primary" : "bg-gray-300"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform
                ${form.isEnabled ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save Rule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Auto-Assignment Rules Section ────────────────────────────────────────────

interface AggregatedRule {
  rule: ShoeAutoAssignRule;
  shoe: RunningShoe;
}

interface AutoAssignRulesSectionProps {
  shoes: RunningShoe[];
  activeShoes: RunningShoe[];
  onAddRule: () => void;
  onEditRule: (r: AggregatedRule) => void;
  onDeleteRule: (r: AggregatedRule) => void;
  onToggleRule: (r: AggregatedRule) => void;
}

function AutoAssignRulesSection({
  shoes,
  activeShoes,
  onAddRule,
  onEditRule,
  onDeleteRule,
  onToggleRule,
}: AutoAssignRulesSectionProps) {
  // TODO: support drag-to-reorder for rule priority
  const allRules: AggregatedRule[] = shoes.flatMap((shoe) =>
    (shoe.autoAssignRules ?? []).map((rule) => ({ rule, shoe }))
  );

  const shoeMap = Object.fromEntries(shoes.map((s) => [s.id, s]));

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary">
          Auto-Assignment Rules
        </h2>
        <button
          onClick={onAddRule}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus size={13} />
          Add Rule
        </button>
      </div>

      <p className="text-sm text-textSecondary mb-4">
        Rules assign shoes to runs automatically. Manual assignments always override rules.
        Rules are evaluated in order — first match wins.
      </p>

      {allRules.length === 0 ? (
        <EmptyState
          title="No rules yet"
          description="Add a rule to automatically assign shoes to runs."
          action={
            <button
              onClick={onAddRule}
              className="text-sm text-primary hover:underline"
            >
              Add your first rule →
            </button>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {allRules.map(({ rule, shoe }, idx) => (
            <div
              key={rule.id}
              className={`bg-card rounded-xl border border-border p-4 flex items-center gap-3 ${
                !rule.isEnabled ? "opacity-50" : ""
              }`}
            >
              {/* Index */}
              <span className="text-xs text-textSecondary w-5 shrink-0 tabular-nums text-center">
                {idx + 1}
              </span>

              {/* Enabled toggle */}
              <button
                onClick={() => onToggleRule({ rule, shoe })}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors
                  ${rule.isEnabled ? "bg-primary" : "bg-gray-300"}`}
                aria-label={rule.isEnabled ? "Disable rule" : "Enable rule"}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform
                    ${rule.isEnabled ? "translate-x-[18px]" : "translate-x-0.5"}`}
                />
              </button>

              {/* Description */}
              <p className="flex-1 text-sm text-textPrimary min-w-0">
                {buildRuleDescription(rule, shoeMap[rule.shoeId]?.name ?? "Unknown Shoe")}
              </p>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => onEditRule({ rule, shoe })}
                  aria-label="Edit rule"
                  className="p-1.5 rounded-lg hover:bg-surface text-textSecondary transition-colors"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => onDeleteRule({ rule, shoe })}
                  aria-label="Delete rule"
                  className="p-1.5 rounded-lg hover:bg-surface text-danger transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ShoesPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);

  // Modal state
  const [editingShoe, setEditingShoe] = useState<RunningShoe | null | "new">(null);
  const [backfillShoe, setBackfillShoe] = useState<RunningShoe | null>(null);
  const [editingRule, setEditingRule] = useState<{ rule: ShoeAutoAssignRule | null; shoe: RunningShoe | null } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<RunningShoe | null>(null);

  const loadAll = useCallback(async () => {
    if (!uid) return;
    const [fetchedShoes, fetchedActs, fetchedAssign] = await Promise.all([
      fetchShoes(uid),
      fetchActivities({ limitCount: 500 }),
      fetchManualShoeAssignmentsMap(uid),
    ]);
    setShoes(fetchedShoes);
    setActivities(fetchedActs);
    setAssignments(fetchedAssign);
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    loadAll().catch(console.error).finally(() => setLoading(false));
  }, [uid, loadAll]);

  const activeShoes = shoes.filter((s) => !s.isRetired);
  const retiredShoes = shoes.filter((s) => s.isRetired);

  // ── Shoe save handler ────────────────────────────────────────────────────
  async function handleSaveShoe(shoe: RunningShoe, isNew: boolean) {
    if (!uid) return;

    if (isNew) {
      const id = await createShoe(uid, shoe);
      const created = { ...shoe, id };

      // Check if backfill needed
      if (created.stravaGearId) {
        const matches = activities.filter(
          (a) =>
            isRun(a.type) &&
            a.gear_id === created.stravaGearId &&
            !assignments[String(a.id)]
        );
        if (matches.length > 0) {
          setEditingShoe(null);
          await loadAll(); // refresh so backfill modal has fresh assignment state
          setBackfillShoe(created);
          return;
        }
      }
    } else {
      await updateShoe(uid, shoe.id, shoe);
    }

    setEditingShoe(null);
    await loadAll();
  }

  // ── Shoe delete handler ──────────────────────────────────────────────────
  async function handleDeleteShoe(shoe: RunningShoe) {
    if (!uid) return;

    // Clear all manual assignments pointing to this shoe
    const cleared: Record<string, null> = {};
    for (const [actId, shoeId] of Object.entries(assignments)) {
      if (shoeId === shoe.id) cleared[actId] = null;
    }
    if (Object.keys(cleared).length > 0) {
      await saveManualAssignments(uid, cleared);
    }

    await deleteShoe(uid, shoe.id);
    setDeleteConfirm(null);
    setEditingShoe(null);
    await loadAll();
  }

  // ── Backfill confirm ──────────────────────────────────────────────────────
  async function handleBackfillConfirm() {
    if (!uid || !backfillShoe || !backfillShoe.stravaGearId) return;
    const matches = activities.filter(
      (a) =>
        isRun(a.type) &&
        a.gear_id === backfillShoe.stravaGearId &&
        !assignments[String(a.id)]
    );
    await batchAssignShoe(uid, matches.map((a) => a.id), backfillShoe.id);
    setBackfillShoe(null);
    await loadAll();
  }

  // ── Rule save handler ────────────────────────────────────────────────────
  async function handleSaveRule(rule: ShoeAutoAssignRule) {
    if (!uid) return;
    const shoe = shoes.find((s) => s.id === rule.shoeId);
    if (!shoe) return;

    const existing = shoe.autoAssignRules ?? [];
    const isNew = !existing.find((r) => r.id === rule.id);
    const updated = isNew
      ? [...existing, rule]
      : existing.map((r) => (r.id === rule.id ? rule : r));

    await updateShoe(uid, shoe.id, { autoAssignRules: updated });
    setEditingRule(null);
    await loadAll();
  }

  // ── Rule toggle ───────────────────────────────────────────────────────────
  async function handleToggleRule({ rule, shoe }: { rule: ShoeAutoAssignRule; shoe: RunningShoe }) {
    if (!uid) return;
    const updated = (shoe.autoAssignRules ?? []).map((r) =>
      r.id === rule.id ? { ...r, isEnabled: !r.isEnabled } : r
    );
    await updateShoe(uid, shoe.id, { autoAssignRules: updated });
    await loadAll();
  }

  // ── Rule delete ───────────────────────────────────────────────────────────
  async function handleDeleteRule({ rule, shoe }: { rule: ShoeAutoAssignRule; shoe: RunningShoe }) {
    if (!uid) return;
    const updated = (shoe.autoAssignRules ?? []).filter((r) => r.id !== rule.id);
    await updateShoe(uid, shoe.id, { autoAssignRules: updated });
    await loadAll();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <PageHeader
        title="Shoes"
        subtitle="Mileage tracking and auto-assignment"
        action={
          <button
            onClick={() => setEditingShoe("new")}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-primary rounded-xl hover:bg-primary/90 transition-colors"
          >
            <Plus size={15} />
            Add Shoe
          </button>
        }
      />

      {/* Active shoes */}
      {shoes.length === 0 ? (
        <EmptyState
          title="No shoes yet"
          description="Add your running shoes to start tracking mileage."
          icon={<Footprints />}
          action={
            <button
              onClick={() => setEditingShoe("new")}
              className="text-sm text-primary hover:underline"
            >
              Add your first shoe →
            </button>
          }
        />
      ) : (
        <>
          {activeShoes.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
              {activeShoes.map((shoe) => (
                <ShoeCard
                  key={shoe.id}
                  shoe={shoe}
                  activities={activities}
                  assignments={assignments}
                  onEdit={(s) => setEditingShoe(s)}
                />
              ))}
            </div>
          )}

          {retiredShoes.length > 0 && (
            <>
              <p className="text-sm text-textSecondary mb-4 mt-2">Retired Shoes</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6 opacity-70">
                {retiredShoes.map((shoe) => (
                  <ShoeCard
                    key={shoe.id}
                    shoe={shoe}
                    activities={activities}
                    assignments={assignments}
                    onEdit={(s) => setEditingShoe(s)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Auto-assignment rules */}
      <AutoAssignRulesSection
        shoes={shoes}
        activeShoes={activeShoes}
        onAddRule={() => setEditingRule({ rule: null, shoe: null })}
        onEditRule={({ rule, shoe }) => setEditingRule({ rule, shoe })}
        onDeleteRule={handleDeleteRule}
        onToggleRule={handleToggleRule}
      />

      {/* Modals */}
      {editingShoe !== null && (
        <AddEditShoeModal
          shoe={editingShoe === "new" ? null : editingShoe}
          activities={activities}
          existingShoes={shoes}
          onSave={handleSaveShoe}
          onDelete={(s) => { setEditingShoe(null); setDeleteConfirm(s); }}
          onClose={() => setEditingShoe(null)}
        />
      )}

      {deleteConfirm && (
        <Modal
          title={`Delete "${deleteConfirm.name}"?`}
          onClose={() => setDeleteConfirm(null)}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-textSecondary">
              This will permanently delete the shoe and remove all manual assignments.
              This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteShoe(deleteConfirm)}
                className="px-4 py-2 text-sm font-semibold text-white bg-danger rounded-lg hover:bg-danger/90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </Modal>
      )}

      {backfillShoe && (
        <BackfillModal
          shoe={backfillShoe}
          unassignedMatches={activities.filter(
            (a) =>
              isRun(a.type) &&
              a.gear_id === backfillShoe.stravaGearId &&
              !assignments[String(a.id)]
          )}
          onConfirm={handleBackfillConfirm}
          onSkip={() => setBackfillShoe(null)}
        />
      )}

      {editingRule !== null && (
        <AddEditRuleModal
          rule={editingRule.rule}
          targetShoe={editingRule.shoe}
          activeShoes={activeShoes}
          onSave={handleSaveRule}
          onClose={() => setEditingRule(null)}
        />
      )}
    </div>
  );
}
