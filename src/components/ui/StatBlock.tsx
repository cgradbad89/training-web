import React from "react";

interface StatBlockProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Optional sub-label shown below the value */
  sublabel?: string;
  className?: string;
}

export function StatBlock({ label, value, unit, sublabel, className = "" }: StatBlockProps) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums text-textPrimary">{value}</span>
        {unit && <span className="text-sm text-gray-500">{unit}</span>}
      </div>
      {sublabel && <span className="text-xs text-gray-400">{sublabel}</span>}
    </div>
  );
}
