import { 
  type RunningPlan, 
  type WorkoutPlan,
  isExerciseItem,
  isSectionItem
} from "@/types/plan";

function escapeCsvField(field: string | number | null | undefined): string {
  if (field === null || field === undefined) return "";
  const str = String(field);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getFormattedDate(startDateStr: string, weekNumber: number, weekday: number): string {
  // startDateStr is e.g. "2024-07-08", weekNumber is 1-based, weekday is 1-based (1=Mon)
  const [year, month, day] = startDateStr.split("T")[0].split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const daysOffset = (weekNumber - 1) * 7 + (weekday - 1);
  date.setDate(date.getDate() + daysOffset);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function generateRunningPlanCsv(plan: RunningPlan): string {
  const headers = [
    "Date",
    "Week Number",
    "Day",
    "Run Type",
    "Distance (mi)",
    "Target Pace",
    "Target HR (bpm)",
    "Scheduled Time",
    "Description",
    "Notes"
  ];

  const rows: string[][] = [];

  for (const week of plan.weeks) {
    // Sort entries by weekday
    const sortedEntries = [...week.entries].sort((a, b) => a.weekday - b.weekday);
    
    for (const entry of sortedEntries) {
      rows.push([
        getFormattedDate(plan.startDate, week.weekNumber, entry.weekday),
        String(week.weekNumber),
        WEEKDAYS[entry.weekday - 1] ?? String(entry.weekday),
        entry.runType ?? "",
        entry.distanceMiles > 0 ? String(entry.distanceMiles) : "",
        entry.paceTarget ?? "",
        entry.targetHeartRate ? String(entry.targetHeartRate) : "",
        entry.scheduledTime ?? "",
        entry.description ?? "",
        entry.notes ?? ""
      ]);
    }
  }

  return [
    headers.join(","),
    ...rows.map(row => row.map(escapeCsvField).join(","))
  ].join("\n");
}

export function generateWorkoutPlanCsv(plan: WorkoutPlan): string {
  const headers = [
    "Date",
    "Week Number",
    "Day",
    "Type",
    "Category",
    "Label",
    "Duration (mins)",
    "Exercise/Section Name",
    "Sets",
    "Reps",
    "Weight (lbs)",
    "Notes"
  ];

  const rows: string[][] = [];

  for (const week of plan.weeks) {
    const sortedEntries = [...week.entries].sort((a, b) => a.weekday - b.weekday);
    
    for (const entry of sortedEntries) {
      const baseRow = [
        getFormattedDate(plan.startDate, week.weekNumber, entry.weekday),
        String(week.weekNumber),
        WEEKDAYS[entry.weekday - 1] ?? String(entry.weekday),
        entry.type ?? "",
        entry.category ?? "",
        entry.label ?? "",
        entry.duration_mins ? String(entry.duration_mins) : "",
      ];

      if (!entry.exercises || entry.exercises.length === 0) {
        // Duration-only or rest day
        rows.push([
          ...baseRow,
          "", "", "", "", entry.notes ?? ""
        ]);
        continue;
      }

      for (const item of entry.exercises) {
        if (isSectionItem(item)) {
          rows.push([
            ...baseRow,
            `--- ${item.title} ---`, "", "", "", ""
          ]);
        } else if (isExerciseItem(item)) {
          rows.push([
            ...baseRow,
            item.name,
            String(item.sets),
            String(item.reps),
            String(item.weight_lbs),
            item.notes ?? ""
          ]);
        }
      }
    }
  }

  return [
    headers.join(","),
    ...rows.map(row => row.map(escapeCsvField).join(","))
  ].join("\n");
}
