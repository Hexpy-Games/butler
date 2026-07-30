import { readFileSync, writeFileSync } from "node:fs";
import type {
  BenchmarkEvidenceFile,
  BenchmarkTarget,
  BtccRevision,
} from "./contracts.ts";
import { evaluateBenchmarkEvidence } from "./evaluate.ts";
import {
  createBenchmarkPlan,
  createEmptyBenchmarkEvidence,
} from "./plan.ts";

interface BenchmarkInitConfig {
  runId: string;
  createdAt: string;
  targets: Record<BtccRevision, BenchmarkTarget>;
  fixtures: Record<string, string>;
}

export function runBtccRevisionBenchmarkCli(argv: string[]): void {
  const command = argv[0];
  if (command === "init") {
    const config = readJson<BenchmarkInitConfig>(requiredOption(argv, "--config"));
    const plan = createBenchmarkPlan(config);
    writeJson(requiredOption(argv, "--output"), createEmptyBenchmarkEvidence(plan));
    return;
  }
  if (command === "evaluate") {
    const evidence = readJson<BenchmarkEvidenceFile>(requiredOption(argv, "--input"));
    writeJson(requiredOption(argv, "--output"), evaluateBenchmarkEvidence(evidence));
    return;
  }
  throw new Error([
    "BTCC Revision 2/3 paired E2E benchmark",
    "  init --config CONFIG.json --output EVIDENCE.json",
    "  evaluate --input EVIDENCE.json --output REPORT.json",
  ].join("\n"));
}

function requiredOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) runBtccRevisionBenchmarkCli(process.argv.slice(2));
