"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Activity, HeartPulse, Save, Sparkles } from "lucide-react";

import { InfoTooltip } from "@/components/ui/InfoTooltip";
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

function FieldLabel({
  htmlFor,
  label,
  tooltip,
}: {
  htmlFor: string;
  label: string;
  tooltip: string;
}) {
  return (
    <div className="flex items-center text-sm font-medium text-textPrimary mb-1">
      <label htmlFor={htmlFor}>{label}</label>
      <InfoTooltip
        ariaLabel={`About ${label}`}
        content={tooltip}
        widthPx={300}
      />
    </div>
  );
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
  const [restingHeartRate, setRestingHeartRate] = useState("");
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
        setRestingHeartRate(
          settings?.restingHeartRate ? String(settings.restingHeartRate) : ""
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
      const parsedRestingHr = restingHeartRate.trim()
        ? Number(restingHeartRate.trim())
        : undefined;
      if (
        parsedRestingHr !== undefined &&
        (!Number.isFinite(parsedRestingHr) ||
          parsedRestingHr < 30 ||
          parsedRestingHr > 120)
      ) {
        setError("Resting heart rate must be between 30 and 120 bpm.");
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
        restingHeartRate: parsedRestingHr,
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
    <div className="flex flex-col gap-6">
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

        <FieldLabel
          htmlFor="max-heart-rate"
          label="Max heart rate"
          tooltip="Your highest sustainable heart rate, in beats per minute. Used to calculate your heart-rate training zones (Z1-Z5) shown on each run. Tap 'Suggest from my runs' to estimate it from the highest heart rates recorded in your recent runs, or enter it manually if you know it."
        />
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            id="max-heart-rate"
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

        <div className="mt-6">
          <FieldLabel
            htmlFor="resting-heart-rate"
            label="Resting heart rate (bpm)"
            tooltip="Your heart rate at complete rest, in beats per minute (e.g. measured first thing in the morning). Used with your max heart rate to compute heart-rate reserve for the Training Load score. Defaults to 60 bpm if left blank."
          />
          <input
            id="resting-heart-rate"
            type="number"
            inputMode="numeric"
            min={30}
            max={120}
            value={restingHeartRate}
            onChange={(e) => setRestingHeartRate(e.target.value)}
            className="input sm:max-w-40"
            placeholder="60"
          />
          <p className="mt-2 text-xs text-textSecondary">
            Leave blank to use the default of 60 bpm.
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle
          icon={Activity}
          title="Threshold Pace"
          subtitle="Manual threshold pace, with a prediction-based suggestion."
        />

        <FieldLabel
          htmlFor="threshold-pace"
          label="Threshold pace"
          tooltip="Roughly the fastest pace you could hold for about an hour (near 10-mile to half-marathon race effort). Used as the reference point for pace-based training zones. The suggested value comes from your predicted 10-mile pace; override it if you have a more accurate number."
        />
        <input
          id="threshold-pace"
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
            <FieldLabel
              htmlFor="display-name"
              label="Display name"
              tooltip="The name shown for your profile within the app."
            />
            <input
              id="display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input"
              placeholder="Name"
            />
          </div>
          <div>
            <FieldLabel
              htmlFor="default-target-pace"
              label="Default target pace"
              tooltip="Your default goal pace, used to pre-fill pace targets when planning runs. This is a planning default, not a fitness measurement."
            />
            <input
              id="default-target-pace"
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
