import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type {
  RunAggregate,
  ScenarioObservation,
} from "../contracts.ts";

export function writeScenarioReport(row: ScenarioObservation): string {
  const path = join(row.preservedRoot, "scenario-observation.json");
  writeJson(path, row);
  return path;
}

export function writeAggregateReport(report: RunAggregate): string {
  const path = join(report.outputRoot, "live-diagnostic-aggregate.json");
  writeJson(path, report);
  return path;
}

export function relativeReportPath(runRoot: string, reportPath: string): string {
  return relative(runRoot, reportPath).split("\\").join("/");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
