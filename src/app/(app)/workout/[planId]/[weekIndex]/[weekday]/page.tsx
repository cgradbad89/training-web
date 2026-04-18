"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle, Circle, ChevronLeft, ChevronRight, Play } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useAuth } from "@/hooks/useAuth";
import { fetchPlan, updatePlan } from "@/services/plans";
import {
  type WorkoutPlan,
  type PlannedWorkoutEntry,
  type PlanExercise,
  type ExerciseItem,
  isWorkoutPlan,
  isDurationOnlyEntry,
  isExerciseItem,
  isSectionItem,
} from "@/types/plan";

// ─── Helpers ────────────────────────────────────────────────────────────────

function dayDate(startDate: string, weekIndex: number, weekday: number): Date {
  const [year, month, day] = startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const offset = weekIndex * 7 + (weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + offset);
  return d;
}

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// ─── Set logging state ──────────────────────────────────────────────────────

interface SetLog {
  reps: number;
  weight: number;
  done: boolean;
}

interface ExerciseLog {
  exerciseId: string;
  sets: SetLog[];
}

function initLogs(exercises: PlanExercise[]): ExerciseLog[] {
  return exercises.map((ex) => ({
    exerciseId: ex.id,
    sets: Array.from({ length: ex.sets }, () => ({
      reps: ex.reps,
      weight: ex.weight_lbs,
      done: false,
    })),
  }));
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function WorkoutDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const planId = params.planId as string;
  const weekIndex = parseInt(params.weekIndex as string, 10);
  const weekday = parseInt(params.weekday as string, 10);

  const [plan, setPlan] = useState<WorkoutPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Start Workout mode
  const [activeMode, setActiveMode] = useState(false);
  const [currentExIdx, setCurrentExIdx] = useState(0);
  const [logs, setLogs] = useState<ExerciseLog[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!uid || !planId) return;
    setLoading(true);
    fetchPlan(uid, planId)
      .then((p) => {
        if (!p || !isWorkoutPlan(p)) {
          setNotFound(true);
          return;
        }
        setPlan(p);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [uid, planId]);

  // Derive session
  const session: PlannedWorkoutEntry | null = (() => {
    if (!plan) return null;
    const week = plan.weeks[weekIndex];
    if (!week) return null;
    const entry = week.entries.find(
      (e) => e.weekday === weekday && e.type === "workout"
    );
    return entry ?? null;
  })();

  // All items in the session (exercises + section headers).
  // Normalize legacy items that lack the `kind` discriminator.
  const allItems: ExerciseItem[] = (session?.exercises ?? []).map((raw) => {
    if ("kind" in raw && raw.kind != null) return raw;
    // Legacy exercise without kind — safe to cast after adding discriminator
    const legacy = raw as unknown as Record<string, unknown>;
    return {
      id: (legacy.id as string) ?? "",
      kind: "exercise" as const,
      name: (legacy.name as string) ?? "",
      sets: (legacy.sets as number) ?? 0,
      reps: (legacy.reps as number) ?? 0,
      weight_lbs: (legacy.weight_lbs as number) ?? 0,
      notes: legacy.notes as string | undefined,
    };
  });
  // Only actual exercises (for Start Workout mode navigation + counting)
  const exercises = allItems.filter(isExerciseItem) as (PlanExercise & { kind: "exercise" })[];
  const isDuration = session ? isDurationOnlyEntry(session) : false;
  const sessionDate = plan
    ? dayDate(plan.startDate, weekIndex, weekday)
    : null;

  // Build a map of exerciseId → section title for Start Workout subtitle
  const sectionForExercise = (() => {
    const map = new Map<string, string>();
    let currentSection = "";
    for (const item of allItems) {
      if (isSectionItem(item)) {
        currentSection = item.title;
      } else if (isExerciseItem(item)) {
        if (currentSection) map.set(item.id, currentSection);
      }
    }
    return map;
  })();

  // Start workout handler
  const handleStartWorkout = useCallback(() => {
    if (exercises.length === 0) return;
    setLogs(initLogs(exercises));
    setCurrentExIdx(0);
    setActiveMode(true);
  }, [exercises]);

  // Update a single set log
  function updateSetLog(
    exIdx: number,
    setIdx: number,
    patch: Partial<SetLog>
  ) {
    setLogs((prev) =>
      prev.map((exLog, i) =>
        i === exIdx
          ? {
              ...exLog,
              sets: exLog.sets.map((s, j) =>
                j === setIdx ? { ...s, ...patch } : s
              ),
            }
          : exLog
      )
    );
  }

  // Finish workout — mark completed in Firestore
  async function handleFinish() {
    if (!uid || !plan || !session) return;
    setFinishing(true);
    try {
      const updatedWeeks = plan.weeks.map((w, wi) => {
        if (wi !== weekIndex) return w;
        return {
          ...w,
          entries: w.entries.map((e) =>
            e.id === session.id
              ? { ...e, completed: true, completedAt: new Date().toISOString() }
              : e
          ),
        };
      });
      const updated: WorkoutPlan = { ...plan, weeks: updatedWeeks };
      await updatePlan(uid, updated);
      setPlan(updated);
      setFinished(true);
      setTimeout(() => router.back(), 2000);
    } catch (err) {
      console.error("[WorkoutDetail] finish failed:", err);
    } finally {
      setFinishing(false);
    }
  }

  // ── Loading / not-found ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (notFound || !plan || !session) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-textSecondary">Workout not found</p>
        <button
          onClick={() => router.back()}
          className="text-primary text-sm font-medium"
        >
          Go back
        </button>
      </div>
    );
  }

  // ── Finished state ──────────────────────────────────────────────────────

  if (finished) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <CheckCircle className="w-12 h-12 text-success" />
        <p className="text-lg font-bold text-textPrimary">Workout complete!</p>
        <button
          onClick={() => router.back()}
          className="text-sm text-primary font-medium hover:underline"
        >
          Back to Plan
        </button>
      </div>
    );
  }

  // ── Start Workout mode ──────────────────────────────────────────────────

  if (activeMode && exercises.length > 0) {
    const ex = exercises[currentExIdx];
    const exLog = logs[currentExIdx];
    const isLast = currentExIdx === exercises.length - 1;
    const isFirst = currentExIdx === 0;
    const allSetsDone = exLog?.sets.every((s) => s.done) ?? false;

    return (
      <div className="max-w-2xl mx-auto p-4 lg:p-6 flex flex-col gap-6 min-h-[80vh]">
        {/* Progress */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => {
              setActiveMode(false);
              setCurrentExIdx(0);
            }}
            className="text-sm text-textSecondary hover:text-textPrimary"
          >
            ← Exit
          </button>
          <span className="text-xs text-textSecondary font-medium">
            Exercise {currentExIdx + 1} of {exercises.length}
          </span>
          <div className="w-12" />
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-surface rounded-full overflow-hidden border border-border">
          {/* TODO: review for dark mode — bg-purple-500 is workout plan brand accent color */}
          <div
            className="h-full bg-purple-500 rounded-full transition-all duration-300"
            style={{
              width: `${((currentExIdx + (allSetsDone ? 1 : 0.5)) / exercises.length) * 100}%`,
            }}
          />
        </div>

        {/* Exercise card */}
        <div className="bg-card rounded-2xl border border-border p-6 flex-1 flex flex-col gap-5">
          <div>
            {sectionForExercise.has(ex.id) && (
              // TODO: review for dark mode — text-purple-600 workout section accent
              <p className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-1">
                {sectionForExercise.get(ex.id)}
              </p>
            )}
            <h2 className="text-xl font-bold text-textPrimary">{ex.name}</h2>
            <p className="text-sm text-textSecondary mt-1">
              {ex.sets} sets × {ex.reps} reps
              {ex.weight_lbs > 0 && ` @ ${ex.weight_lbs} lbs`}
            </p>
            {ex.notes?.trim() && (
              <p className="text-xs text-textSecondary italic mt-1">
                {ex.notes}
              </p>
            )}
          </div>

          {/* Set rows */}
          <div className="flex flex-col gap-2">
            {exLog?.sets.map((setLog, setIdx) => (
              <div
                key={setIdx}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                  setLog.done
                    ? "bg-success/5 border-success/20"
                    : "bg-surface border-border"
                }`}
              >
                <button
                  onClick={() =>
                    updateSetLog(currentExIdx, setIdx, {
                      done: !setLog.done,
                    })
                  }
                  className="shrink-0"
                >
                  {setLog.done ? (
                    <CheckCircle className="w-5 h-5 text-success" />
                  ) : (
                    <Circle className="w-5 h-5 text-border" />
                  )}
                </button>
                <span className="text-sm font-semibold text-textPrimary w-12 shrink-0">
                  Set {setIdx + 1}
                </span>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="number"
                    value={setLog.reps}
                    onChange={(e) =>
                      updateSetLog(currentExIdx, setIdx, {
                        reps: parseInt(e.target.value, 10) || 0,
                      })
                    }
                    className="w-16 text-sm text-center border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
                    min={0}
                  />
                  <span className="text-xs text-textSecondary">reps</span>
                  <input
                    type="number"
                    value={setLog.weight}
                    onChange={(e) =>
                      updateSetLog(currentExIdx, setIdx, {
                        weight: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-20 text-sm text-center border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary"
                    min={0}
                    step={2.5}
                  />
                  <span className="text-xs text-textSecondary">lbs</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setCurrentExIdx((i) => i - 1)}
            disabled={isFirst}
            className="flex items-center gap-1 px-4 py-2 text-sm border border-border rounded-xl text-textSecondary hover:bg-surface disabled:opacity-30"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>

          {isLast ? (
            <button
              onClick={handleFinish}
              disabled={finishing}
              className="px-6 py-2 text-sm font-semibold text-white bg-success rounded-xl hover:bg-success/90 disabled:opacity-50"
            >
              {finishing ? "Saving…" : "Finish Workout"}
            </button>
          ) : (
            <button
              onClick={() => setCurrentExIdx((i) => i + 1)}
              className="flex items-center gap-1 px-4 py-2 text-sm font-semibold text-white bg-primary rounded-xl hover:bg-primary/90"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Full view (default) ─────────────────────────────────────────────────

  const dateLabel = sessionDate
    ? `${DAY_NAMES[weekday]}, ${sessionDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : null;

  return (
    <div className="max-w-2xl mx-auto p-4 lg:p-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-xl hover:bg-surface transition-colors text-textSecondary"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-textPrimary truncate">
            {plan.name}
            {session.label && ` · ${session.label}`}
          </h1>
          {dateLabel && (
            <p className="text-sm text-textSecondary">{dateLabel}</p>
          )}
        </div>
        {!isDuration && exercises.length > 0 && !session.completed && (
          <button
            onClick={handleStartWorkout}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-xl hover:bg-primary/90 shrink-0"
          >
            <Play className="w-4 h-4" />
            Start Workout
          </button>
        )}
      </div>

      {/* Completed badge */}
      {session.completed && (
        <div className="flex items-center gap-2 text-success bg-success/10 px-4 py-2 rounded-xl">
          <CheckCircle className="w-5 h-5" />
          <span className="text-sm font-medium">
            Completed
            {session.completedAt &&
              ` · ${new Date(session.completedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })} at ${new Date(session.completedAt).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}`}
          </span>
        </div>
      )}

      {/* Duration-only session */}
      {isDuration && (
        <div className="bg-card rounded-2xl border border-border p-5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-textPrimary">
              {session.label ?? "Session"}
            </span>
            {session.duration_mins != null && (
              <span className="text-sm text-textSecondary">
                · {session.duration_mins} min
              </span>
            )}
          </div>
          {session.notes && (
            <p className="text-sm text-textSecondary mt-3">{session.notes}</p>
          )}
        </div>
      )}

      {/* Exercise list (with section headers + per-exercise notes) */}
      {!isDuration && allItems.length > 0 && (() => {
        let exNum = 0;
        return (
          <div className="bg-card rounded-2xl border border-border divide-y divide-border">
            {allItems.map((item) => {
              if (isSectionItem(item)) {
                return (
                  // TODO: review for dark mode — bg-purple-50/text-purple-600 workout section accent
                  <div
                    key={item.id}
                    className="px-4 py-2.5 bg-purple-50"
                  >
                    <p className="text-xs font-bold text-purple-600 uppercase tracking-wide">
                      {item.title}
                    </p>
                  </div>
                );
              }
              if (isExerciseItem(item)) {
                exNum += 1;
                return (
                  <div key={item.id} className="p-4">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-textSecondary w-6 shrink-0 text-center">
                        {exNum}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-textPrimary">
                          {item.name}
                        </p>
                        <p className="text-xs text-textSecondary mt-0.5 tabular-nums">
                          {item.sets} × {item.reps}
                          {item.weight_lbs > 0 && ` @ ${item.weight_lbs} lbs`}
                        </p>
                        {item.notes?.trim() && (
                          <p className="text-xs text-textSecondary italic mt-1">
                            {item.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })}
          </div>
        );
      })()}

      {/* Exercise-based but empty */}
      {!isDuration && exercises.length === 0 && (
        <div className="bg-card rounded-2xl border border-border p-5 text-center">
          <p className="text-sm text-textSecondary">
            No exercises added to this session yet.
          </p>
        </div>
      )}

      {/* Session notes */}
      {session.notes && !isDuration && (
        <div className="bg-card rounded-2xl border border-border p-5">
          <h3 className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
            Notes
          </h3>
          <p className="text-sm text-textPrimary whitespace-pre-wrap">
            {session.notes}
          </p>
        </div>
      )}
    </div>
  );
}
