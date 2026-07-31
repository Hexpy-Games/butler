import { readFileSync, writeFileSync } from "node:fs";
import type {
  BenchmarkAssessmentFile,
  BenchmarkEvidenceFile,
  BenchmarkTarget,
  BtccRevision,
} from "./contracts.ts";
import { applyProductAssessments } from "./assess.ts";
import { evaluateBenchmarkEvidence } from "./evaluate.ts";
import {
  createBenchmarkPlan,
  createEmptyBenchmarkEvidence,
} from "./plan.ts";
import {
  runBenchmarkPairs,
  type BenchmarkRunnerConfig,
} from "./runner.ts";

interface BenchmarkInitConfig {
  runId: string;
  createdAt: string;
  targets: Record<BtccRevision, BenchmarkTarget>;
  fixtures: Record<string, string>;
}

export async function runBtccRevisionBenchmarkCli(argv: string[]): Promise<void> {
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
  if (command === "assess") {
    const evidence = readJson<BenchmarkEvidenceFile>(requiredOption(argv, "--input"));
    const assessments = readJson<BenchmarkAssessmentFile>(
      requiredOption(argv, "--assessment"),
    );
    writeJson(
      requiredOption(argv, "--output"),
      applyProductAssessments(evidence, assessments),
    );
    return;
  }
  if (command === "run") {
    const inputPath = requiredOption(argv, "--input");
    const outputPath = requiredOption(argv, "--output");
    const evidence = readJson<BenchmarkEvidenceFile>(inputPath);
    const config = readJson<BenchmarkRunnerConfig>(requiredOption(argv, "--config"));
    await runBenchmarkPairs({
      config,
      evidence,
      dependencies: {
        persist: (updated) => writeJson(outputPath, updated),
      },
    });
    writeJson(outputPath, evidence);
    return;
  }
  throw new Error([
    "BTCC Revision 2/3 paired E2E benchmark",
    "  init --config CONFIG.json --output EVIDENCE.json",
    "  run --input EVIDENCE.json --config RUNNER.json --output EVIDENCE.json",
    "  assess --input EVIDENCE.json --assessment ASSESSMENTS.json --output EVIDENCE.json",
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

if (import.meta.main) await runBtccRevisionBenchmarkCli(process.argv.slice(2));
