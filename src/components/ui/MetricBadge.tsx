import React from "react";

type Level = "good" | "ok" | "low" | "high" | "neutral";

interface MetricBadgeProps {
  label: string;
  value: string | number;
  level?: Level;
}

const levelStyles: Record<Level, string> = {
  good: "bg-green-100 text-green-800",
  ok: "bg-yellow-100 text-yellow-800",
  low: "bg-orange-100 text-orange-800",
  high: "bg-red-100 text-red-800",
  neutral: "bg-gray-100 text-gray-700",
};

export function MetricBadge({ label, value, level = "neutral" }: MetricBadgeProps) {
  return (
    <div className={`inline-flex flex-col items-center px-2.5 py-1.5 rounded-lg text-center ${levelStyles[level]}`}>
      <span className="text-xs font-medium leading-none">{label}</span>
      <span className="text-sm font-bold tabular-nums mt-0.5">{value}</span>
    </div>
  );
}
