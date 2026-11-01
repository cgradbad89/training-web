"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useAppData } from "@/contexts/AppDataContext";
import { useManualActivityActions } from "@/hooks/useManualActivityActions";
import { fetchHealthWorkoutsInRange } from "@/services/healthWorkouts";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  createManualActivityId,
  emptyManualActivityForm,
  findPossibleDuplicates,
  formValuesFromWorkout,
  localDateTimeToInstant,
  manualPaceSecPerMile,
  MANUAL_ACTIVITY_KIND_ORDER,
  MANUAL_ACTIVITY_KINDS,
  parseManualActivityForm,
  type ManualActivityErrors,
  type ManualActivityField,
  type ManualActivityFormValues,
  type ManualActivityInput,
  type ManualActivityKind,
  type PossibleDuplicate,
} from "@/utils/manualActivity";
import { useAuth } from "@/hooks/useAuth";
import { formatDuration, formatMiles, formatPace } from "@/utils/pace";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";

export type ManualActivityModalMode =
  | { type: "create"; defaultKind: ManualActivityKind }
  | { type: "edit"; workout: HealthWorkout };

interface ManualActivityModalProps {
  mode: ManualActivityModalMode;
  onClose: () => void;
  onSaved: (workout: HealthWorkout) => void;
}

const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-textPrimary " +
  "placeholder:text-textSecondary focus:outline-none focus:ring-2 focus:ring-primary/40 " +
  "aria-[invalid=true]:border-danger";

function Field({
  id, label, optional, error, hint, children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold text-textSecondary">
        {label}
        {optional && <span className="font-normal"> (optional)</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-textSecondary">{hint}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function dayBefore(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() - days);
  return shifted;
}

export function ManualActivityModal({ mode, onClose, onSaved }: ManualActivityModalProps) {
  const { user } = useAuth();
  const { workouts, workoutsHistoryComplete } = useAppData();
  const { create, update } = useManualActivityActions();
  const isEdit = mode.type === "edit";
  const editing = isEdit ? mode.workout : null;

  const [values, setValues] = useState<ManualActivityFormValues>(() =>
    mode.type === "edit"
      ? formValuesFromWorkout(mode.workout)
      : emptyManualActivityForm(mode.defaultKind)
  );
  const [errors, setErrors] = useState<ManualActivityErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<{
    input: ManualActivityInput;
    matches: PossibleDuplicate[];
  } | null>(null);
  // Generated before the first attempt and reused by every retry from this form,
  // so a save whose acknowledgement was lost can never create a second record.
  const [idempotencyId] = useState(createManualActivityId);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-heading`;
  const fieldId = (name: string) => `${baseId}-${name}`;

  const config = MANUAL_ACTIVITY_KINDS[values.kind];

  // Held in a ref: the parent's inline onClose changes on every AppData render,
  // which must not re-run the mount effect below and steal focus mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => {
    if (!savingRef.current) onCloseRef.current();
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, [href]'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [requestClose]);

  const setField = <K extends keyof ManualActivityFormValues>(
    key: K,
    value: ManualActivityFormValues[K]
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDuplicates(null);
    setSaveError(null);
  };

  const clearError = (field: ManualActivityField) =>
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });

  const pace = useMemo(() => {
    if (config.distance === "none") return null;
    const toPart = (raw: string) => (raw.trim() === "" ? 0 : Number(raw));
    return manualPaceSecPerMile(
      toPart(values.hours) * 3600 + toPart(values.minutes) * 60 + toPart(values.seconds),
      values.distanceMiles.trim() === "" ? null : Number(values.distanceMiles)
    );
  }, [config.distance, values.hours, values.minutes, values.seconds, values.distanceMiles]);

  /** Already-loaded history first; a targeted day-window read only when the date
   *  predates a capped history (never a full-history scan). */
  const candidatesFor = useCallback(
    async (input: ManualActivityInput): Promise<HealthWorkout[]> => {
      const start = localDateTimeToInstant(input.localDate, input.localTime);
      const oldest = workouts[workouts.length - 1];
      if (!start || !user || workoutsHistoryComplete || !oldest || start >= dayBefore(oldest.startDate, -1)) {
        return workouts;
      }
      return fetchHealthWorkoutsInRange(user.uid, dayBefore(start, 1), dayBefore(start, -2));
    },
    [user, workouts, workoutsHistoryComplete]
  );

  const persist = async (input: ManualActivityInput) => {
    const saved = editing
      ? (await update(editing.workoutId, input)).workout
      : await create(input, idempotencyId);
    onSaved(saved);
  };

  const submit = async (skipDuplicateCheck: boolean) => {
    if (savingRef.current) return;
    const parsed = parseManualActivityForm(values);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    setSaveError(null);
    savingRef.current = true;
    setSaving(true);
    try {
      if (!isEdit && !skipDuplicateCheck) {
        let matches: PossibleDuplicate[] = [];
        try {
          matches = findPossibleDuplicates(parsed.input, await candidatesFor(parsed.input));
        } catch (err) {
          // An unavailable older window must not stop a legitimate save.
          console.warn("[ManualActivityModal] duplicate check skipped", err);
        }
        if (matches.length > 0) {
          setDuplicates({ input: parsed.input, matches });
          return;
        }
      }
      await persist(parsed.input);
    } catch (err) {
      setDuplicates(null);
      setSaveError(err instanceof Error ? err.message : "Nothing was saved. Please try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const describedBy = (field: ManualActivityField) =>
    errors[field] ? `${fieldId(field)}-error` : undefined;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 lg:items-center lg:p-4"
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl lg:max-h-[90vh] lg:max-w-lg lg:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border p-5">
          <h2 id={titleId} className="text-base font-semibold text-textPrimary">
            {isEdit ? "Edit Activity" : "Add Activity"}
          </h2>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label="Close"
            className="rounded-lg p-1.5 text-textSecondary transition-colors hover:bg-surface disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5">
            <Field id={fieldId("kind")} label="Activity type" error={errors.kind}>
              <select
                ref={firstFieldRef}
                id={fieldId("kind")}
                className={inputClass}
                value={values.kind}
                aria-invalid={Boolean(errors.kind)}
                aria-describedby={describedBy("kind")}
                onChange={(event) => {
                  setField("kind", event.target.value as ManualActivityKind);
                  clearError("kind");
                  clearError("distance");
                }}
              >
                {MANUAL_ACTIVITY_KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {MANUAL_ACTIVITY_KINDS[kind].label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field id={fieldId("date")} label="Date" error={errors.date}>
                <input
                  id={fieldId("date")}
                  type="date"
                  className={inputClass}
                  value={values.date}
                  aria-invalid={Boolean(errors.date)}
                  aria-describedby={describedBy("date")}
                  onChange={(event) => { setField("date", event.target.value); clearError("date"); clearError("time"); }}
                />
              </Field>
              <Field id={fieldId("time")} label="Start time" error={errors.time}>
                <input
                  id={fieldId("time")}
                  type="time"
                  className={inputClass}
                  value={values.time}
                  aria-invalid={Boolean(errors.time)}
                  aria-describedby={describedBy("time")}
                  onChange={(event) => { setField("time", event.target.value); clearError("time"); }}
                />
              </Field>
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs font-semibold text-textSecondary">Duration</legend>
              <div className="grid grid-cols-3 gap-3">
                {(["hours", "minutes", "seconds"] as const).map((part) => (
                  <div key={part} className="flex min-w-0 items-center gap-1.5">
                    <input
                      id={fieldId(part)}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={part === "hours" ? 24 : 59}
                      step={1}
                      placeholder="0"
                      aria-label={part}
                      className={inputClass}
                      value={values[part]}
                      aria-invalid={Boolean(errors.duration)}
                      aria-describedby={describedBy("duration")}
                      onChange={(event) => { setField(part, event.target.value); clearError("duration"); }}
                    />
                    <span className="text-xs text-textSecondary">{part[0]}</span>
                  </div>
                ))}
              </div>
              {errors.duration && (
                <p id={`${fieldId("duration")}-error`} role="alert" className="text-xs text-danger">
                  {errors.duration}
                </p>
              )}
            </fieldset>

            {config.distance !== "none" && (
              <Field
                id={fieldId("distance")}
                label="Distance (miles)"
                optional={config.distance === "optional"}
                error={errors.distance}
                hint={pace !== null ? `Pace: ${formatPace(pace)} /mi` : undefined}
              >
                <input
                  id={fieldId("distance")}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  className={inputClass}
                  value={values.distanceMiles}
                  aria-invalid={Boolean(errors.distance)}
                  aria-describedby={describedBy("distance")}
                  onChange={(event) => { setField("distanceMiles", event.target.value); clearError("distance"); }}
                />
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field id={fieldId("avgHeartRate")} label="Average HR (bpm)" optional error={errors.avgHeartRate}>
                <input
                  id={fieldId("avgHeartRate")}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  className={inputClass}
                  value={values.avgHeartRate}
                  aria-invalid={Boolean(errors.avgHeartRate)}
                  aria-describedby={describedBy("avgHeartRate")}
                  onChange={(event) => { setField("avgHeartRate", event.target.value); clearError("avgHeartRate"); }}
                />
              </Field>
              <Field id={fieldId("calories")} label="Calories" optional error={errors.calories}>
                <input
                  id={fieldId("calories")}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  className={inputClass}
                  value={values.calories}
                  aria-invalid={Boolean(errors.calories)}
                  aria-describedby={describedBy("calories")}
                  onChange={(event) => { setField("calories", event.target.value); clearError("calories"); }}
                />
              </Field>
            </div>

            <Field id={fieldId("title")} label="Title" optional error={errors.title}>
              <input
                id={fieldId("title")}
                type="text"
                className={inputClass}
                value={values.title}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={describedBy("title")}
                onChange={(event) => { setField("title", event.target.value); clearError("title"); }}
              />
            </Field>

            <Field id={fieldId("notes")} label="Notes" optional error={errors.notes}>
              <textarea
                id={fieldId("notes")}
                rows={3}
                className={inputClass}
                value={values.notes}
                aria-invalid={Boolean(errors.notes)}
                aria-describedby={describedBy("notes")}
                onChange={(event) => { setField("notes", event.target.value); clearError("notes"); }}
              />
            </Field>
          </div>

          {/* Pinned outside the scroller: a warning below the fold would leave
              "Save Anyway" on screen with no visible reason. */}
          {(duplicates || saveError) && (
            <div className="flex max-h-[45%] shrink-0 flex-col gap-3 overflow-y-auto border-t border-border px-5 pt-4">
                {duplicates && (
                  <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 p-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
                      <p className="text-sm font-medium text-textPrimary">
                        This may already be recorded. Save it only if it&apos;s a separate activity.
                      </p>
                    </div>
                    <ul className="mt-3 flex flex-col gap-2">
                      {duplicates.matches.map(({ workout, reasons }) => (
                        <li key={workout.workoutId} className="text-xs text-textSecondary">
                          <span className="font-medium text-textPrimary">
                            {resolveActivityTitle({
                              customTitle: workout.customTitle,
                              activityType: workout.displayType,
                              rawActivityType: workout.isRunLike ? undefined : workout.activityType,
                              distanceMiles: workout.distanceMiles,
                            })}
                          </span>
                          {" · "}
                          {workout.startDate.toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                          })}
                          {" · "}
                          {formatDuration(workout.durationSeconds)}
                          {workout.distanceMiles > 0 && ` · ${formatMiles(workout.distanceMiles)} mi`}
                          {" · "}
                          {workout.sourceName}
                          <br />
                          {reasons.join(" · ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {saveError && (
                  <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                    {saveError}
                  </p>
                )}
            </div>
          )}

          <div className="flex shrink-0 justify-end gap-2 border-t border-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={requestClose}
              disabled={saving}
              className="rounded-xl border border-border px-4 py-2 text-sm text-textSecondary transition-colors hover:bg-surface disabled:opacity-50"
            >
              Cancel
            </button>
            {duplicates ? (
              <button
                type="button"
                onClick={() => void submit(true)}
                disabled={saving}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Anyway"}
              </button>
            ) : (
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
