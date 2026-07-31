import {
  BTCC_REVISION_BENCHMARK_SCHEMA,
  type BenchmarkEvidenceFile,
  type BenchmarkPlan,
  type BenchmarkTarget,
  type BtccRevision,
} from "./contracts.ts";
import { materializeBenchmarkCorpus } from "./corpus.ts";

const BUILD_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function createBenchmarkPlan(input: {
  runId: string;
  createdAt: string;
  targets: Record<BtccRevision, BenchmarkTarget>;
  fixtures: Record<string, string>;
}): BenchmarkPlan {
  if (!input.runId.trim() || Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error("Benchmark run identity is incomplete");
  }
  validateIsolatedTargets(input.targets);
  return {
    schema: BTCC_REVISION_BENCHMARK_SCHEMA,
    kind: "paired_e2e_plan",
    runId: input.runId,
    createdAt: input.createdAt,
    targets: input.targets,
    prompts: materializeBenchmarkCorpus(input.fixtures),
  };
}

export function createEmptyBenchmarkEvidence(plan: BenchmarkPlan): BenchmarkEvidenceFile {
  return {
    schema: BTCC_REVISION_BENCHMARK_SCHEMA,
    kind: "paired_e2e_evidence",
    plan,
    observations: [],
  };
}

function validateIsolatedTargets(targets: Record<BtccRevision, BenchmarkTarget>): void {
  if (targets.r2.revision !== "r2" || targets.r3.revision !== "r3") {
    throw new Error("Benchmark target revisions do not match");
  }
  const isolatedFields: Array<keyof BenchmarkTarget> = [
    "worktreePath",
    "appBaseUrl",
    "electronDebugPort",
    "dataRoot",
    "electronUserData",
    "workspaceRoot",
  ];
  for (const field of isolatedFields) {
    if (targets.r2[field] === targets.r3[field]) {
      throw new Error(`Benchmark targets must isolate ${field}`);
    }
  }
  for (const field of ["model", "reasoningEffort", "permissionMode", "fixtureHash"] as const) {
    if (targets.r2[field] !== targets.r3[field]) {
      throw new Error(`Benchmark targets must share ${field}`);
    }
  }
  for (const target of Object.values(targets)) {
    const strings = Object.entries(target).filter(([field]) =>
      field !== "revision" && field !== "electronDebugPort",
    );
    if (
      strings.some(([, value]) => typeof value !== "string" || !value.trim()) ||
      !Number.isSafeInteger(target.electronDebugPort) ||
      target.electronDebugPort <= 0
    ) throw new Error(`Benchmark ${target.revision} target identity is incomplete`);
    if (!BUILD_ID_PATTERN.test(target.buildId)) {
      throw new Error(
        `Benchmark ${target.revision} buildId must be sha256:<digest>`,
      );
    }
  }
}
