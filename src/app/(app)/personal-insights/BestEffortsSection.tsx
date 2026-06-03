"use client";

import Link from "next/link";
import React, { useMemo } from "react";

import { type HealthWorkout } from "@/types/healthWorkout";
import {
  computeBestEffortRecords,
  type BestEffortRecord,
} from "@/utils/bestEffortRecords";
import { type BestEffortKey } from "@/utils/bestEfforts";
import { formatDuration, formatPaceLabel } from "@/utils/pace";

const DISPLAY_ORDER: Array<{ key: BestEffortKey; label: string }> = [
  { key: "1mi", label: "1mi" },
  { key: "5k", label: "5K" },
  { key: "10k", label: "10K" },
  { key: "10mi", label: "10mi" },
  { key: "half", label: "Half" },
];

function formatRecordDate(dateIso: string): string {
  return new Date(dateIso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function RecordContent({
  label,
  record,
}: {
  label: string;
  record: BestEffortRecord | null;
}) {
  return (
    <>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-textPrimary">{label}</p>
        <p className="text-xs text-textSecondary">
          {record ? formatRecordDate(record.date) : "No effort yet"}
        </p>
      </div>

      <div className="text-right">
        <p className="text-xl font-bold text-textPrimary tabular-nums">
          {record ? formatDuration(record.timeSeconds) : "—"}
        </p>
        <p className="text-xs text-textSecondary tabular-nums">
          {record ? `${formatPaceLabel(record.paceSecPerMile)} /mi` : "—"}
        </p>
      </div>

      <div className="flex justify-end">
        {record?.isRecent ? (
          <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
            NEW PR
          </span>
        ) : null}
      </div>
    </>
  );
}

export function BestEffortsSection({
  runs,
}: {
  runs: HealthWorkout[];
}): React.JSX.Element {
  const records = useMemo(
    () => computeBestEffortRecords(runs, new Date()),
    [runs]
  );
  const hasAnyRecord = DISPLAY_ORDER.some(({ key }) => records[key] !== null);

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <div className="mb-4">
        <p className="text-xs text-textSecondary">
          Fastest continuous segment of each distance across all GPS runs.
        </p>
      </div>

      {!hasAnyRecord ? (
        <div className="rounded-xl bg-surface border border-border p-4 text-center mb-2">
          <p className="text-sm text-textSecondary">
            Best efforts will appear once your runs are processed.
          </p>
        </div>
      ) : null}

      <div className="divide-y divide-border">
        {DISPLAY_ORDER.map(({ key, label }) => {
          const record = records[key];
          const rowClasses =
            "grid grid-cols-[minmax(0,1fr)_auto_4rem] items-center gap-3 py-3 transition-colors";

          if (!record) {
            return (
              <div key={key} className={rowClasses}>
                <RecordContent label={label} record={record} />
              </div>
            );
          }

          return (
            <Link
              key={key}
              href={`/runs/${record.workoutId}`}
              className={`${rowClasses} rounded-lg hover:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30`}
            >
              <RecordContent label={label} record={record} />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
