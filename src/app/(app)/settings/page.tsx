"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Activity, HeartPulse, Save, Sparkles } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchUserSettings,
  gatherRecentRunHr,
  saveUserSettings,
  saveUserSettingsSuggestions,
} from "@/services/userSettings";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchRaces } from "@/services/races";
import { RACE_DISTANCE_MILES } from "@/types/race";
import { formatPace, parsePaceString } from "@/utils/pace";
import { computeMaxHrSuggestion } from "@/utils/maxHrSuggestion";
import {
  buildQualifyingEfforts,
  fitRiegel,
  predictSeconds,
} from "@/utils/riegelFit";
import {
  computeThresholdPaceSuggestion,
  type ThresholdPaceSuggestion,
} from "@/utils/thresholdPaceSuggestion";

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-card rounded-2xl shadow-sm border border-border p-5 ${className}`}>
      {children}
    </section>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-5">
      <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon size={18} />
      </div>
      <div>
        <h2 className="text-base font-bold text-textPrimary">{title}</h2>
        <p className="text-sm text-textSecondary mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

function sourceLabel(source: ThresholdPaceSuggestion["source"]): string {
  return source === "10mi"
    ? "your predicted 10-mile pace"
    : "your predicted half-marathon pace";
}

export default function SettingsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [suggestingHr, setSuggestingHr] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [defaultTargetPace, setDefaultTargetPace] = useState("");
  const [maxHeartRate, setMaxHeartRate] = useState("");
  const [thresholdPace, setThresholdPace] = useState("");
  const [suggestedMaxHeartRate, setSuggestedMaxHeartRate] = useState<
    number | null
  >(null);
  const [thresholdSuggestion, setThresholdSuggestion] =
    useState<ThresholdPaceSuggestion | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;

    setLoading(true);
    Promise.all([
      fetchUserSettings(uid),
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchRaces(uid),
    ])
      .then(([settings, workouts, races]) => {
        if (cancelled) return;

        setDisplayName(settings?.displayName ?? user?.displayName ?? "");
        setDefaultTargetPace(
          settings?.defaultTargetPaceSecPerMile
            ? formatPace(settings.defaultTargetPaceSecPerMile)
            : "10:00"
        );
        setMaxHeartRate(
          settings?.maxHeartRate ? String(settings.maxHeartRate) : ""
        );
        setThresholdPace(
          settings?.thresholdPaceSecPerMile
            ? formatPace(settings.thresholdPaceSecPerMile)
            : ""
        );
        setSuggestedMaxHeartRate(settings?.suggestedMaxHeartRate ?? null);

        const runs = workouts.filter((w) => w.isRunLike);
        const runInputs = runs.map((r) => ({
          workoutId: r.workoutId,
          distanceMiles: r.distanceMiles,
          durationSeconds: r.durationSeconds,
          startDate: r.startDate,
          activityType: r.activityType,
          sourceName: r.sourceName,
        }));
        const raceInputs = races
          .map((race) => {
            const distanceMiles =
              race.raceDistance === "custom"
                ? (race.customDistanceMiles ?? 0)
                : (RACE_DISTANCE_MILES[race.raceDistance] ?? 0);
            return { raceDate: race.raceDate, distanceMiles };
          })
          .filter((race) => race.distanceMiles > 0);
        const efforts = buildQualifyingEfforts(runInputs, 56, {
          races: raceInputs,
        });
        const fitTen = fitRiegel(efforts, 10.0, 3.0, {
          min: 1.04,
          max: 1.10,
        });
        const fitHalf = fitRiegel(efforts, 13.109, 3.0, {
          min: 1.04,
          max: 1.10,
        });
        const suggestion = computeThresholdPaceSuggestion(
          fitTen ? predictSeconds(fitTen, 10.0) : null,
          fitHalf ? predictSeconds(fitHalf, 13.109) : null
        );
        setThresholdSuggestion(suggestion);
      })
      .catch((err) => {
        console.error("[SettingsPage] load failed", err);
        if (!cancelled) setError("Could not load settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [uid, user?.displayName]);

  const defaultTargetPaceSeconds = useMemo(
    () => parsePaceString(defaultTargetPace),
    [defaultTargetPace]
  );
  const thresholdPaceSeconds = useMemo(
    () => parsePaceString(thresholdPace),
    [thresholdPace]
  );

  async function handleSuggestMaxHr() {
    if (!uid || suggestingHr) return;

    setSuggestingHr(true);
    setMessage(null);
    setError(null);
    try {
      const values = await gatherRecentRunHr(uid);
      const suggestion = computeMaxHrSuggestion(values);
      setSuggestedMaxHeartRate(suggestion);
      if (suggestion) {
        await saveUserSettingsSuggestions(uid, {
          suggestedMaxHeartRate: suggestion,
          suggestedThresholdPaceSecPerMile:
            thresholdSuggestion?.paceSecPerMile,
        });
        setMessage(`Suggested ${suggestion} bpm from ${values.length} HR samples.`);
      } else {
        setError("Not enough valid route heart-rate samples for a suggestion.");
      }
    } catch (err) {
      console.error("[SettingsPage] max HR suggestion failed", err);
      setError("Could not compute a max HR suggestion.");
    } finally {
      setSuggestingHr(false);
    }
  }

  async function handleSave() {
    if (!uid || saving) return;

    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const parsedMaxHr = maxHeartRate.trim()
        ? Number(maxHeartRate.trim())
        : undefined;
      if (
        parsedMaxHr !== undefined &&
        (!Number.isFinite(parsedMaxHr) || parsedMaxHr < 100 || parsedMaxHr > 230)
      ) {
        setError("Max heart rate must be between 100 and 230 bpm.");
        return;
      }
      if (defaultTargetPace.trim() && defaultTargetPaceSeconds == null) {
        setError("Default target pace must use m:ss format.");
        return;
      }
      if (thresholdPace.trim() && thresholdPaceSeconds == null) {
        setError("Threshold pace must use m:ss format.");
        return;
      }

      await saveUserSettings(uid, {
        displayName: displayName.trim() || undefined,
        email: user?.email ?? undefined,
        defaultTargetPaceSecPerMile: defaultTargetPaceSeconds ?? 600,
        maxHeartRate: parsedMaxHr,
        thresholdPaceSecPerMile: thresholdPaceSeconds ?? undefined,
        suggestedMaxHeartRate: suggestedMaxHeartRate ?? undefined,
        suggestedThresholdPaceSecPerMile:
          thresholdSuggestion?.paceSecPerMile ?? undefined,
      });
      setMessage("Settings saved.");
    } catch (err) {
      console.error("[SettingsPage] save failed", err);
      setError("Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-textPrimary">Settings</h1>
        <p className="text-sm text-textSecondary mt-1">
          Athlete profile values used to personalize zones and workout guidance.
        </p>
      </div>

      <Card>
        <SectionTitle
          icon={HeartPulse}
          title="Max Heart Rate"
          subtitle="Used for heart-rate zones on run detail pages."
        />

        <label className="block text-sm font-medium text-textPrimary mb-1">
          Max heart rate
        </label>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="number"
            inputMode="numeric"
            min={100}
            max={230}
            value={maxHeartRate}
            onChange={(e) => setMaxHeartRate(e.target.value)}
            className="input sm:max-w-40"
            placeholder="185"
          />
          <button
            type="button"
            onClick={handleSuggestMaxHr}
            disabled={suggestingHr}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary/10 text-primary px-4 py-2 text-sm font-semibold hover:bg-primary/20 disabled:opacity-50 transition-colors"
          >
            {suggestingHr ? <LoadingSpinner size="sm" /> : <Sparkles size={16} />}
            Suggest from my runs
          </button>
        </div>

        {suggestedMaxHeartRate ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-textSecondary">
              Suggested:{" "}
              <span className="font-semibold text-textPrimary">
                {suggestedMaxHeartRate} bpm
              </span>{" "}
              based on your runs
            </span>
            <button
              type="button"
              onClick={() => setMaxHeartRate(String(suggestedMaxHeartRate))}
              className="text-primary text-sm font-semibold hover:underline"
            >
              Accept
            </button>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle
          icon={Activity}
          title="Threshold Pace"
          subtitle="Manual threshold pace, with a prediction-based suggestion."
        />

        <label className="block text-sm font-medium text-textPrimary mb-1">
          Threshold pace
        </label>
        <input
          type="text"
          value={thresholdPace}
          onChange={(e) => setThresholdPace(e.target.value)}
          className="input sm:max-w-40"
          placeholder="7:30"
        />
        <p className="text-xs text-textSecondary mt-1">Use m:ss per mile.</p>

        {thresholdSuggestion ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-textSecondary">
              Suggested:{" "}
              <span className="font-semibold text-textPrimary">
                {formatPace(thresholdSuggestion.paceSecPerMile)} /mi
              </span>{" "}
              from {sourceLabel(thresholdSuggestion.source)}
            </span>
            <button
              type="button"
              onClick={() =>
                setThresholdPace(formatPace(thresholdSuggestion.paceSecPerMile))
              }
              className="text-primary text-sm font-semibold hover:underline"
            >
              Accept
            </button>
          </div>
        ) : (
          <p className="text-sm text-textSecondary mt-3">
            No prediction-based threshold suggestion is available yet.
          </p>
        )}
      </Card>

      <Card>
        <SectionTitle
          icon={Save}
          title="General Preferences"
          subtitle="Basic display and default training values."
        />

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-textPrimary mb-1">
              Display name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input"
              placeholder="Name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-textPrimary mb-1">
              Default target pace
            </label>
            <input
              type="text"
              value={defaultTargetPace}
              onChange={(e) => setDefaultTargetPace(e.target.value)}
              className="input"
              placeholder="10:00"
            />
            <p className="text-xs text-textSecondary mt-1">Use m:ss per mile.</p>
          </div>
        </div>
      </Card>

      {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
      {message ? (
        <p className="text-sm font-medium text-success">{message}</p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-primary text-white px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {saving ? <LoadingSpinner size="sm" /> : <Save size={16} />}
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
