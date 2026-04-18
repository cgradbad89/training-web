import React from "react";

type Level = "good" | "ok" | "low" | "high" | "neutral";

interface MetricBadgeProps {
  label: string;
  value: string | number;
  level?: Level;
}

const levelInlineStyles: Record<Exclude<Level, "neutral">, React.CSSProperties> = {
  good: { backgroundColor: "var(--color-level-great)", color: "var(--color-level-great-text)" },
  ok:   { backgroundColor: "var(--color-level-good)",  color: "var(--color-level-good-text)"  },
  low:  { backgroundColor: "var(--color-level-fair)",  color: "var(--color-level-fair-text)"  },
  high: { backgroundColor: "var(--color-level-poor)",  color: "var(--color-level-poor-text)"  },
};

export function MetricBadge({ label, value, level = "neutral" }: MetricBadgeProps) {
  const inlineStyle = level !== "neutral" ? levelInlineStyles[level] : undefined;
  return (
    <div
      className={`inline-flex flex-col items-center px-2.5 py-1.5 rounded-lg text-center${level === "neutral" ? " bg-surface text-textPrimary" : ""}`}
      style={inlineStyle}
    >
      <span className="text-xs font-medium leading-none">{label}</span>
      <span className="text-sm font-bold tabular-nums mt-0.5">{value}</span>
    </div>
  );
}
