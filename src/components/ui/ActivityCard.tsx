import React from "react";
import { type StravaActivity } from "@/types";
import { formatMiles, formatDuration, formatPace } from "@/utils";
import { activityTypeLabel } from "@/utils";

interface ActivityCardProps {
  activity: StravaActivity;
  onClick?: () => void;
}

export function ActivityCard({ activity, onClick }: ActivityCardProps) {
  const date = new Date(activity.start_date_local || activity.start_date);
  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === "Enter" && onClick() : undefined}
      className={`bg-card rounded-xl p-4 shadow-sm border border-border flex flex-col gap-2 ${
        onClick ? "cursor-pointer hover:shadow-md transition-shadow" : ""
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-textSecondary">{dateLabel}</p>
          <p className="font-semibold text-textPrimary leading-tight">{activity.name}</p>
          <p className="text-xs text-textSecondary">{activityTypeLabel(activity.type)}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold tabular-nums">{formatMiles(activity.distance_miles)}</p>
          <p className="text-xs text-gray-500">mi</p>
        </div>
      </div>

      <div className="flex gap-4 flex-wrap text-sm">
        <div className="text-textSecondary">
          <span className="text-textSecondary text-xs">Pace </span>
          {activity.pace_min_per_mile}
          <span className="text-textSecondary text-xs"> /mi</span>
        </div>
        <div className="text-textSecondary">
          <span className="text-textSecondary text-xs">Time </span>
          {formatDuration(activity.moving_time_s)}
        </div>
        {activity.avg_heartrate && (
          <div className="text-textSecondary">
            <span className="text-textSecondary text-xs">HR </span>
            {Math.round(activity.avg_heartrate)}
            <span className="text-textSecondary text-xs"> bpm</span>
          </div>
        )}
      </div>
    </div>
  );
}
