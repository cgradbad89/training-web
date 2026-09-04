"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface EditablePlan {
  id: string;
  name: string;
}

interface UsePlanDraftEditOptions<TPlan extends EditablePlan> {
  plan: TPlan;
  onSave: (updated: TPlan) => void | Promise<void>;
  onEditSessionChange?: (
    planId: string,
    isEditing: boolean,
    isDirty: boolean,
    discard: () => void
  ) => void;
}

function clonePlan<TPlan>(plan: TPlan): TPlan {
  return structuredClone(plan);
}

function plansEqual<TPlan>(left: TPlan, right: TPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Owns a plan's explicit Edit → Done transaction.
 *
 * Mutations update a local deep-cloned draft. Done persists that complete draft
 * once and exits edit mode only after the write succeeds. A rejected write
 * intentionally keeps the draft alive so the user can retry without re-entering
 * their changes.
 */
export function usePlanDraftEdit<TPlan extends EditablePlan>({
  plan,
  onSave,
  onEditSessionChange,
}: UsePlanDraftEditOptions<TPlan>) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [draftPlan, setDraftPlan] = useState<TPlan | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const editablePlan = isEditMode && draftPlan ? draftPlan : plan;
  const isDirty = useMemo(
    () => isEditMode && draftPlan !== null && !plansEqual(draftPlan, plan),
    [draftPlan, isEditMode, plan]
  );

  const beginEdit = useCallback(() => {
    setDraftPlan(clonePlan(plan));
    setSaveError(null);
    setShowDiscardConfirm(false);
    setIsEditMode(true);
  }, [plan]);

  const updateDraft = useCallback((updater: (current: TPlan) => TPlan) => {
    setSaveError(null);
    setDraftPlan((current) => (current ? updater(current) : current));
  }, []);

  const discardDraft = useCallback(() => {
    if (savingRef.current) return;
    setDraftPlan(null);
    setSaveError(null);
    setShowDiscardConfirm(false);
    setIsEditMode(false);
  }, []);

  useEffect(() => {
    onEditSessionChange?.(plan.id, isEditMode, isDirty, discardDraft);
  }, [discardDraft, isDirty, isEditMode, onEditSessionChange, plan.id]);

  const requestDiscard = useCallback(() => {
    if (isSaving) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    discardDraft();
  }, [discardDraft, isDirty, isSaving]);

  const saveAndFinish = useCallback(async (): Promise<"saved" | "unchanged" | false> => {
    if (!isEditMode || !draftPlan || savingRef.current) return false;

    const trimmedName = draftPlan.name.trim();
    if (!trimmedName) {
      setSaveError("Enter a plan name before saving.");
      return false;
    }

    const planToSave =
      trimmedName === draftPlan.name
        ? draftPlan
        : ({ ...draftPlan, name: trimmedName } as TPlan);

    if (plansEqual(planToSave, plan)) {
      discardDraft();
      return "unchanged";
    }

    savingRef.current = true;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(planToSave);
      setDraftPlan(null);
      setIsEditMode(false);
      return "saved";
    } catch (error) {
      console.error("[PlanDraftEdit] save failed", error);
      setSaveError("Changes couldn't be saved. Your draft is still here — try again.");
      return false;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [discardDraft, draftPlan, isEditMode, onSave, plan]);

  return {
    editablePlan,
    isEditMode,
    isDirty,
    isSaving,
    saveError,
    showDiscardConfirm,
    beginEdit,
    updateDraft,
    requestDiscard,
    discardDraft,
    cancelDiscard: () => setShowDiscardConfirm(false),
    saveAndFinish,
  };
}
