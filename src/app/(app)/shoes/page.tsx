"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Pencil, Trash2, Plus, X, Footprints } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/hooks/useAuth";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import {
  fetchShoes,
  createShoe,
  updateShoe,
  deleteShoe,
  fetchManualShoeAssignmentsMap,
  saveManualAssignments,
} from "@/services/shoes";
import { formatPace } from "@/utils/pace";
import { formatShortDate } from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  type RunningShoe,
  type ShoeAutoAssignRule,
} from "@/types/shoe";
import { evaluateAutoAssignRules } from "@/utils/shoeAutoAssign";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shoeAssignedRuns(
  shoe: RunningShoe,
  activities: HealthWorkout[],
  assignments: Record<string, string | null>
): HealthWorkout[] {
  return activities.filter(
    (a) => a.isRunLike && assignments[a.workoutId] === shoe.id
  );
}

function totalMileage(
  shoe: RunningShoe,
  activities: HealthWorkout[],
  assignments: Record<string, string | null>
): number {
  const runs = shoeAssignedRuns(shoe, activities, assignments);
  return shoe.startMileageOffset + runs.reduce((s, r) => s + r.distanceMiles, 0);
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
  activities: HealthWorkout[];
  assignments: Record<string, string | null>;
  onEdit: (shoe: RunningShoe) => void;
  onManageRuns: (shoe: RunningShoe) => void;
}

function ShoeCard({ shoe, activities, assignments, onEdit, onManageRuns }: ShoeCardProps) {
  const assigned = shoeAssignedRuns(shoe, activities, assignments);
  const miles = totalMileage(shoe, activities, assignments);

  const totalTime = assigned.reduce((s, r) => s + r.durationSeconds, 0);
  const totalDist = assigned.reduce((s, r) => s + r.distanceMiles, 0);
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
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              shoe.isRetired
                ? "bg-surface text-textSecondary"
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
      <button
        onClick={() => onManageRuns(shoe)}
        className="text-xs font-medium text-primary hover:text-primary/80 transition-colors text-left"
      >
        Manage Runs →
      </button>
    </div>
  );
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  onSave,
  children,
}: {
  title: string;
  onClose: () => void;
  onSave?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 overflow-hidden"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative z-10 bg-card rounded-2xl shadow-xl border border-border w-full max-w-[480px] flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
          <button onClick={onClose} className="text-sm text-textSecondary">
            Cancel
          </button>
          <h2 className="text-sm font-semibold text-textPrimary">{title}</h2>
          {onSave ? (
            <button onClick={onSave} className="text-sm font-semibold text-primary">
              Save
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

// ─── Add/Edit Shoe Modal ──────────────────────────────────────────────────────

interface ShoeFormState {
  name: string;
  brand: string;
  model: string;
  purchaseDate: string;
  startMileageOffset: string;
  retirementMileageTarget: string;
  notes: string;
  isRetired: boolean;
}

interface AddEditShoeModalProps {
  shoe: RunningShoe | null;
  onSave: (shoe: RunningShoe, isNew: boolean) => Promise<void>;
  onDelete: (shoe: RunningShoe) => void;
  onClose: () => void;
}

function AddEditShoeModal({
  shoe,
  onSave,
  onDelete,
  onClose,
}: AddEditShoeModalProps) {
  const isNew = !shoe;

  const [form, setForm] = useState<ShoeFormState>(() => ({
    name: shoe?.name ?? "",
    brand: shoe?.brand ?? "",
    model: shoe?.model ?? "",
    purchaseDate: shoe?.purchaseDate ?? "",
    startMileageOffset: String(shoe?.startMileageOffset ?? 0),
    retirementMileageTarget: shoe?.retirementMileageTarget != null
      ? String(shoe.retirementMileageTarget)
      : "",
    notes: shoe?.notes ?? "",
    isRetired: shoe?.isRetired ?? false,
  }));
  const [initialForm] = useState<ShoeFormState>(() => ({ ...form }));
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  useUnsavedChanges(isDirty);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set(field: keyof ShoeFormState, value: string | boolean) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function doSave() {
    setError("");
    if (!form.name.trim()) {
      setError("Shoe name is required.");
      return;
    }

    setSaving(true);
    try {
      const data: Omit<RunningShoe, "id" | "addedAt"> = {
        name: form.name.trim(),
        brand: form.brand.trim() || '',
        model: form.model.trim() || '',
        purchaseDate: form.purchaseDate || undefined,
        startMileageOffset: parseFloat(form.startMileageOffset) || 0,
        retirementMileageTarget: form.retirementMileageTarget
          ? Number(form.retirementMileageTarget)
          : undefined,
        notes: form.notes.trim() || '',
        isRetired: form.isRetired,
        autoAssignRules: shoe?.autoAssignRules ?? [],
      };

      const full: RunningShoe = shoe
        ? { ...shoe, ...data }
        : { ...data, id: "", addedAt: "" };

      await onSave(full, isNew);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await doSave();
  }

  const notesLen = form.notes.length;

  return (
    <Modal title={isNew ? "Add Shoe" : "Edit Shoe"} onClose={onClose} onSave={doSave}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
              ${form.isRetired ? "bg-border" : "bg-primary"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform
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
          <div className="hidden" />
        </div>
      </form>
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
  targetShoe: RunningShoe | null;
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
  const [initialForm] = useState<RuleFormState>(() => ({ ...form }));
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  useUnsavedChanges(isDirty);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function set<K extends keyof RuleFormState>(field: K, value: RuleFormState[K]) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function doSave() {
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await doSave();
  }

  const SCOPES: { value: RuleFormState["scope"]; label: string }[] = [
    { value: "any", label: "All Runs" },
    { value: "outdoor", label: "Outdoor Only" },
    { value: "treadmill", label: "Treadmill Only" },
  ];

  return (
    <Modal title={isNew ? "Add Rule" : "Edit Rule"} onClose={onClose} onSave={doSave}>
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
              ${form.isEnabled ? "bg-primary" : "bg-border"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform
                ${form.isEnabled ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="hidden" />
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
                  ${rule.isEnabled ? "bg-primary" : "bg-border"}`}
                aria-label={rule.isEnabled ? "Disable rule" : "Enable rule"}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-card shadow transition-transform
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

// ─── Runs Slide-Over Panel ────────────────────────────────────────────────────

interface RunsPanelProps {
  shoe: RunningShoe;
  activities: HealthWorkout[];
  assignments: Record<string, string | null>;
  onClose: () => void;
  onAssignmentChange: (activityId: string, shoeId: string | null) => Promise<void>;
}

function RunsPanel({
  shoe,
  activities,
  assignments,
  onClose,
  onAssignmentChange,
}: RunsPanelProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");

  // Animate in on mount
  useEffect(() => {
    const t = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  const runs = useMemo(
    () => activities.filter((a) => a.isRunLike),
    [activities]
  );

  const assignedRuns = useMemo(
    () =>
      runs
        .filter((r) => assignments[r.workoutId] === shoe.id)
        .sort((a, b) => b.startDate.getTime() - a.startDate.getTime()),
    [runs, assignments, shoe.id]
  );

  const miles = totalMileage(shoe, activities, assignments);

  // Picker: show runs not assigned to any other shoe + runs assigned to this shoe
  const pickerRuns = useMemo(() => {
    const base = runs.filter((r) => {
      const a = assignments[r.workoutId];
      return a == null || a === shoe.id;
    });
    const q = search.trim().toLowerCase();
    const filtered = q
      ? base.filter((r) => r.displayType.toLowerCase().includes(q))
      : base;
    return [...filtered].sort(
      (a, b) => b.startDate.getTime() - a.startDate.getTime()
    );
  }, [runs, assignments, shoe.id, search]);

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
      />

      {/* Slide-over panel */}
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-md bg-card shadow-xl z-50 flex flex-col transition-transform duration-300 ${
          isVisible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Sticky header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card sticky top-0 z-10">
          <button
            onClick={onClose}
            className="text-sm text-textSecondary hover:text-textPrimary flex items-center gap-1 transition-colors"
          >
            ← Close
          </button>
          <h2 className="text-sm font-semibold text-textPrimary truncate mx-2 flex-1 text-center">
            {shoe.name}
          </h2>
          <span className="text-sm font-semibold text-textPrimary tabular-nums shrink-0">
            {miles.toFixed(1)} mi
          </span>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4">
          {showPicker ? (
            <>
              {/* Picker header */}
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-textPrimary">Add Runs</h3>
                <button
                  onClick={() => {
                    setShowPicker(false);
                    setSearch("");
                  }}
                  className="text-sm font-semibold text-primary"
                >
                  Done
                </button>
              </div>

              {/* Search bar */}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or date…"
                className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-card text-textPrimary mb-3 focus:outline-none focus:ring-2 focus:ring-primary"
              />

              {/* Picker run list */}
              {pickerRuns.length === 0 ? (
                <p className="text-sm text-textSecondary text-center py-8">No runs found.</p>
              ) : (
                <div className="flex flex-col">
                  {pickerRuns.map((run) => {
                    const isChecked = assignments[run.workoutId] === shoe.id;
                    return (
                      <label
                        key={run.workoutId}
                        className="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-surface cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={async (e) => {
                            await onAssignmentChange(
                              run.workoutId,
                              e.target.checked ? shoe.id : null
                            );
                          }}
                          className="w-4 h-4 accent-primary shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-textSecondary shrink-0">
                              {formatShortDate(run.startDate)}
                            </span>
                            <span className="text-sm font-medium text-textPrimary truncate">
                              {run.displayType}
                            </span>
                          </div>
                          <div className="text-xs text-textSecondary mt-0.5">
                            {run.distanceMiles.toFixed(1)} mi
                            {run.avgPaceSecPerMile
                              ? ` · ${Math.floor(run.avgPaceSecPerMile / 60)}:${String(Math.round(run.avgPaceSecPerMile % 60)).padStart(2, "0")}/mi`
                              : ""}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Section 1: Mileage bar */}
              <div className="mb-4">
                <MileageBar miles={miles} target={shoe.retirementMileageTarget} />
              </div>

              {/* Section 2: Add Runs button */}
              <button
                onClick={() => setShowPicker(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-border rounded-xl text-sm font-medium text-textSecondary hover:border-primary hover:text-primary transition-colors mb-5"
              >
                <Plus size={14} />
                Add Runs
              </button>

              {/* Section 3: Assigned runs list */}
              <h3 className="text-xs font-semibold uppercase tracking-widest text-textSecondary mb-2">
                Assigned Runs
              </h3>

              {assignedRuns.length === 0 ? (
                <p className="text-sm text-textSecondary italic text-center py-6">
                  No runs assigned yet. Use &apos;Add Runs&apos; to assign.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {assignedRuns.map((run) => (
                    <div
                      key={run.workoutId}
                      className="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-surface group"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-textSecondary shrink-0">
                            {formatShortDate(run.startDate)}
                          </span>
                          <span className="text-sm font-medium text-textPrimary truncate">
                            {run.displayType}
                          </span>
                        </div>
                        <div className="text-xs text-textSecondary mt-0.5">
                          {run.distanceMiles.toFixed(1)} mi
                          {run.avgPaceSecPerMile
                            ? ` · ${Math.floor(run.avgPaceSecPerMile / 60)}:${String(Math.round(run.avgPaceSecPerMile % 60)).padStart(2, "0")}/mi`
                            : ""}
                          {run.avgHeartRate != null ? ` · ${Math.round(run.avgHeartRate)} bpm` : ""}
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          await onAssignmentChange(run.workoutId, null);
                        }}
                        className="p-1.5 rounded-lg text-textSecondary hover:text-danger hover:bg-surface opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        aria-label="Remove assignment"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ShoesPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [activities, setActivities] = useState<HealthWorkout[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);

  // Modal state
  const [editingShoe, setEditingShoe] = useState<RunningShoe | null | "new">(null);
  const [editingRule, setEditingRule] = useState<{ rule: ShoeAutoAssignRule | null; shoe: RunningShoe | null } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<RunningShoe | null>(null);
  const [deleteRuleConfirm, setDeleteRuleConfirm] = useState<{
    rule: ShoeAutoAssignRule;
    shoe: RunningShoe;
  } | null>(null);

  // Slide-over panel state
  const [runsPanel, setRunsPanel] = useState<RunningShoe | null>(null);

  useEffect(() => {
    const isOpen =
      editingShoe !== null ||
      editingRule !== null ||
      !!deleteConfirm ||
      !!deleteRuleConfirm ||
      !!runsPanel;
    document.body.style.overflow = isOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [editingShoe, editingRule, deleteConfirm, deleteRuleConfirm, runsPanel]);

  const [autoAssignedCount, setAutoAssignedCount] = useState(0);
  const [autoAssignedMap, setAutoAssignedMap] = useState<Record<string, string>>({});
  const [savingAuto, setSavingAuto] = useState(false);
  const [autoSaveMsg, setAutoSaveMsg] = useState<"success" | "error" | null>(null);

  const loadAll = useCallback(async () => {
    if (!uid) return;
    const [fetchedShoes, fetchedActs, fetchedAssign] = await Promise.all([
      fetchShoes(uid),
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchManualShoeAssignmentsMap(uid),
    ]);
    setShoes(fetchedShoes);
    setActivities(fetchedActs);
    // Compute auto-assignments
    const autoAssigned = evaluateAutoAssignRules(fetchedActs, fetchedShoes, fetchedAssign);
    setAutoAssignedMap(autoAssigned);
    setAutoAssignedCount(Object.keys(autoAssigned).length);
    // Merge: manual assignments take precedence
    setAssignments({ ...autoAssigned, ...fetchedAssign });
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    loadAll().catch(console.error).finally(() => setLoading(false));
  }, [uid, loadAll]);

  const activeShoes = shoes.filter((s) => !s.isRetired);
  const retiredShoes = shoes.filter((s) => s.isRetired);

  // ── Assignment change handler (used by RunsPanel) ────────────────────────
  async function handlePanelAssignmentChange(
    activityId: string,
    shoeId: string | null
  ) {
    if (!uid) return;
    // Optimistic update
    setAssignments((prev) => ({ ...prev, [activityId]: shoeId }));
    await saveManualAssignments(uid, { [activityId]: shoeId });
  }

  // ── Shoe save handler ────────────────────────────────────────────────────
  async function handleSaveShoe(shoe: RunningShoe, isNew: boolean) {
    if (!uid) return;

    if (isNew) {
      await createShoe(uid, shoe);
    } else {
      await updateShoe(uid, shoe.id, shoe);
    }

    setEditingShoe(null);
    await loadAll();
  }

  // ── Shoe delete handler ──────────────────────────────────────────────────
  async function handleDeleteShoe(shoe: RunningShoe) {
    if (!uid) return;

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
    setDeleteRuleConfirm(null);
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
              {activeShoes.map((shoe) => (
                <ShoeCard
                  key={shoe.id}
                  shoe={shoe}
                  activities={activities}
                  assignments={assignments}
                  onEdit={(s) => setEditingShoe(s)}
                  onManageRuns={(s) => setRunsPanel(s)}
                />
              ))}
            </div>
          )}

          {retiredShoes.length > 0 && (
            <>
              <p className="text-sm text-textSecondary mb-4 mt-2">Retired Shoes</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6 opacity-70">
                {retiredShoes.map((shoe) => (
                  <ShoeCard
                    key={shoe.id}
                    shoe={shoe}
                    activities={activities}
                    assignments={assignments}
                    onEdit={(s) => setEditingShoe(s)}
                    onManageRuns={(s) => setRunsPanel(s)}
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
        onDeleteRule={({ rule, shoe }) => setDeleteRuleConfirm({ rule, shoe })}
        onToggleRule={handleToggleRule}
      />

      {/* Save auto-assignments */}
      {autoAssignedCount > 0 && (
        <div className="bg-card rounded-2xl border border-border p-5 mt-4">
          <p className="text-sm font-semibold text-textPrimary">
            {autoAssignedCount} {autoAssignedCount === 1 ? "run" : "runs"} matched auto-assignment rules
          </p>
          <p className="text-xs text-textSecondary mt-1 mb-3">
            These runs have been temporarily assigned based on your rules. Save them to make the assignments permanent.
          </p>
          <button
            onClick={async () => {
              if (!uid) return;
              setSavingAuto(true);
              setAutoSaveMsg(null);
              try {
                await saveManualAssignments(uid, autoAssignedMap);
                setAutoAssignedCount(0);
                setAutoAssignedMap({});
                setAutoSaveMsg("success");
                setTimeout(() => setAutoSaveMsg(null), 3000);
              } catch (err) {
                console.error(err);
                setAutoSaveMsg("error");
                setTimeout(() => setAutoSaveMsg(null), 5000);
              }
              setSavingAuto(false);
            }}
            disabled={savingAuto}
            className="px-4 py-2 text-sm font-semibold text-white bg-primary rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {savingAuto ? "Saving..." : "Save Auto-Assignments"}
          </button>
          {autoSaveMsg === "success" && (
            <p className="text-sm text-success font-medium mt-2 transition-opacity">
              Auto-assignments saved
            </p>
          )}
          {autoSaveMsg === "error" && (
            <p className="text-sm text-danger font-medium mt-2">
              Failed to save. Please try again.
            </p>
          )}
        </div>
      )}

      {/* Modals */}
      {editingShoe !== null && (
        <AddEditShoeModal
          shoe={editingShoe === "new" ? null : editingShoe}
          onSave={handleSaveShoe}
          onDelete={(s) => { setEditingShoe(null); setDeleteConfirm(s); }}
          onClose={() => setEditingShoe(null)}
        />
      )}

      <ConfirmDialog
        isOpen={!!deleteConfirm}
        title="Delete this shoe?"
        message="This will remove the shoe and all its mileage history. This cannot be undone."
        confirmLabel="Delete Shoe"
        confirmVariant="danger"
        onConfirm={() => deleteConfirm && handleDeleteShoe(deleteConfirm)}
        onCancel={() => setDeleteConfirm(null)}
      />

      <ConfirmDialog
        isOpen={!!deleteRuleConfirm}
        title="Delete this rule?"
        message="Runs matched by this rule will no longer be auto-assigned."
        confirmLabel="Delete Rule"
        confirmVariant="danger"
        onConfirm={() => deleteRuleConfirm && handleDeleteRule(deleteRuleConfirm)}
        onCancel={() => setDeleteRuleConfirm(null)}
      />

      {editingRule !== null && (
        <AddEditRuleModal
          rule={editingRule.rule}
          targetShoe={editingRule.shoe}
          activeShoes={activeShoes}
          onSave={handleSaveRule}
          onClose={() => setEditingRule(null)}
        />
      )}

      {/* Runs slide-over panel */}
      {runsPanel && (
        <RunsPanel
          shoe={runsPanel}
          activities={activities}
          assignments={assignments}
          onClose={() => setRunsPanel(null)}
          onAssignmentChange={handlePanelAssignmentChange}
        />
      )}
    </div>
  );
}
