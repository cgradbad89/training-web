"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { type WeekAdherenceData } from "@/components/charts/PlanAdherenceChart";

/**
 * Sibling of PlanAdherenceChart. Reads the same WeekAdherenceData[] so the
 * x-axis domain and weekly buckets line up week-for-week with the mileage
 * chart above it. Single "actual" series; styling on CSS-variable tokens.
 */
export function PlanRunLoadChart({ data }: { data: WeekAdherenceData[] }) {
  if (data.length === 0) return null;

  const hasAnyLoad = data.some((w) => w.runLoad > 0);

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
        Weekly Run Load — Plan Progress
      </h2>
      <p className="text-xs text-textSecondary mb-3">
        Actual training load from runs each plan week (runs only).
      </p>
      {hasAnyLoad ? (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={data}
              barGap={2}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={30}
                allowDecimals={false}
              />
              <Tooltip
                formatter={(v) => [`${Math.round(Number(v))}`, "Run load"]}
                contentStyle={{
                  fontSize: 12,
                  backgroundColor: "var(--color-chart-tooltip-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "0.375rem",
                  color: "var(--color-textPrimary)",
                }}
                labelStyle={{ color: "var(--color-textSecondary)" }}
                itemStyle={{ color: "var(--color-textPrimary)" }}
              />
              <Bar
                dataKey="runLoad"
                fill="var(--color-chart-primary)"
                radius={[4, 4, 0, 0]}
                name="runLoad"
              />
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4 mt-3 text-xs text-textSecondary">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded"
                style={{ backgroundColor: "var(--color-chart-primary)" }}
              />{" "}
              Run load (score)
            </span>
          </div>
        </>
      ) : (
        <p className="text-sm text-textSecondary text-center py-6">
          No run load data yet for this plan.
        </p>
      )}
    </div>
  );
}
