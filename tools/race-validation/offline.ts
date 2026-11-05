import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sealCheckpoint } from "./checkpoint";
import { evaluateStudy, type StudyReport } from "./evaluate";
import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";
import { sealOutcome } from "./outcome";
import { METHODS } from "./models";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

function readJson(path: string): unknown {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new TypeError("Expected a local JSON file of at most 32 MiB");
  return JSON.parse(readFileSync(path, "utf8"));
}

function format(value: number | null) {
  return value === null ? "—" : String(Number(value.toFixed(3)));
}

function percentage(value: number | null) {
  return value === null ? "—" : `${format(100 * value)}%`;
}

function cell(value: string) {
  return value.replace(/[\\|`*_[\]<>]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function renderStudy(report: StudyReport): string {
  const lines = [
    "# Half-marathon checkpoint evaluation",
    "",
    `**Evidence class** ${report.captureKind} · **Eligible independent outcomes** ${report.eligibleOutcomeCount}`,
    `**Chronological test begins** ${report.testFromDate}`,
    "",
    "| Split | Lead days | Outcomes | Missing/excluded | Method | Version | Predictions | Available | Abstained | MAE (s) | Bias (s) | ≥300 s | Pairs vs. experiment | Experiment minus comparator MAE (s) |",
    "| --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.summaries) {
    for (const method of METHODS) {
      const stat = row.methods[method];
      const pair = row.pairedAgainstExperimental[method];
      lines.push(`| ${row.split} | ${row.horizon} | ${row.eligibleOutcomes} | ${row.missingOrExcludedCheckpoints} | ${method} | ${report.modelVersions[method]} | ${stat.predictions} | ${percentage(stat.availability)} | ${percentage(stat.abstentionRate)} | ${format(stat.meanAbsoluteErrorSeconds)} | ${format(stat.signedBiasSeconds)} | ${format(stat.errorsAtLeastFiveMinutes)} | ${pair?.count ?? "—"} | ${format(pair?.deltaMeanAbsoluteErrorSeconds ?? null)} |`);
    }
  }

  lines.push("", "## Cases", "");
  if (!report.cases.length) lines.push("No eligible race outcomes.");
  for (const row of report.cases) {
    lines.push(`- ${row.target.raceDate} · ${cell(row.target.raceId)} · ${row.horizon} days · ${row.split} · actual ${format(row.actualSeconds)} s`);
    if (row.reason) lines.push(`  - ${cell(row.reason)}`);
    if (row.coverage) {
      lines.push(`  - Captured ${row.capturedAt} · cutoff ${row.cutoff} · workouts ${row.coverage.workouts}, races ${row.coverage.races}, overrides ${row.coverage.overrides}`);
      for (const limitation of [...row.coverage.limitations, ...row.coverageReasons]) lines.push(`  - ${cell(limitation)}`);
    }
    if (!row.errors) continue;
    for (const method of METHODS) {
      const result = row.errors[method];
      lines.push(result.predictedSeconds === null
        ? `  - ${method} abstained · ${cell(result.reason ?? "Evidence unavailable")}`
        : `  - ${method} · ${format(result.predictedSeconds)} s · absolute error ${format(result.absoluteErrorSeconds)} s · signed error ${format(result.signedErrorSeconds)} s`);
    }
  }
  lines.push("", "## Artifact exclusions", "");
  if (!report.exclusions.length) lines.push("None.");
  for (const row of report.exclusions) lines.push(`- ${row.kind} ${cell(row.ref)} · ${cell(row.reason)}`);
  lines.push("", "## Interpretation", "", ...report.limitations.map(reason => `- ${reason}`), "");
  return lines.join("\n");
}

export function runValidationFiles(options: {
  mode: string;
  input: string;
  output: string;
  custody?: string;
  markdown?: string;
}) {
  const { mode, input, output, custody, markdown } = options;
  if (mode !== "checkpoint" && mode !== "outcome" && mode !== "evaluate") throw new TypeError("Unknown Phase 3D mode");
  if ((custody || markdown) && mode !== "evaluate") throw new TypeError("Custody and Markdown paths apply only to evaluate mode");
  if (markdown && resolve(output) === resolve(markdown)) throw new TypeError("Use distinct JSON and Markdown output paths");
  const value = readJson(input);
  const report = mode === "evaluate" ? evaluateStudy(value, custody ? readJson(custody) : undefined) : null;
  const result = report ?? (mode === "checkpoint" ? sealCheckpoint(value) : sealOutcome(value));
  writeFileSync(output, canonicalizePerformanceValue(result) + "\n", { mode: 0o600, flag: "wx" });
  if (report && markdown) writeFileSync(markdown, renderStudy(report), { mode: 0o600, flag: "wx" });
  return result;
}
