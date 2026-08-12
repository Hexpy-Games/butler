import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  BenchmarkArmPlan,
  BenchmarkObservation,
  BenchmarkPlan,
  BenchmarkResultFile,
  PreflightResult,
  TokenUsage,
  ToolMetrics,
  TimingMetrics,
} from "./contracts.ts";
import { AGENT_BENCHMARK_SCHEMA } from "./contracts.ts";
import { benchmarkPlanIdentity } from "./planning.ts";
import { boundedText } from "./command.ts";
import { sanitizeEffectiveConfig } from "./identifiers.ts";

export interface BenchmarkCheckpointStore {
  load(): Promise<BenchmarkResultFile | null>;
  save(result: BenchmarkResultFile): Promise<void>;
}

export function createFileCheckpointStore(path: string): BenchmarkCheckpointStore {
  return {
    async load(): Promise<BenchmarkResultFile | null> {
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as BenchmarkResultFile;
      } catch {
        throw new Error("Benchmark checkpoint identity mismatch: existing result is unreadable.");
      }
    },
    async save(result: BenchmarkResultFile): Promise<void> {
      const identity = assertResultIdentity(result);
      const persisted = redactBenchmarkResult(result);
      mkdirSync(resolve(path, ".."), { recursive: true });
      if (existsSync(path)) {
        let existing: BenchmarkResultFile;
        try {
          existing = JSON.parse(readFileSync(path, "utf8")) as BenchmarkResultFile;
        } catch {
          throw new Error("Benchmark checkpoint identity mismatch: existing result is unreadable.");
        }
        if (existing.run.planIdentity !== identity) {
          throw new Error("Benchmark checkpoint identity mismatch: replacement runs are not allowed.");
        }
        assertTerminalEvidencePreserved(existing, persisted);
      }
      const temporaryPath = `${path}.tmp-${process.pid}`;
      writeFileSync(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, path);
    },
  };
}

export function resumeOrInitialize(
  plan: BenchmarkPlan,
  checkpoint: BenchmarkResultFile | null,
): BenchmarkResultFile {
  const planIdentity = benchmarkPlanIdentity(plan);
  if (checkpoint) {
    if (checkpoint.schema !== AGENT_BENCHMARK_SCHEMA ||
      checkpoint.kind !== "agent_benchmark_result" ||
      typeof checkpoint.plan.createdAt !== "string" ||
      checkpoint.plan.runId !== plan.runId || checkpoint.plan.seed !== plan.seed ||
      checkpoint.plan.baselineSha !== plan.baselineSha ||
      checkpoint.run.planIdentity !== planIdentity) {
      throw new Error("Benchmark checkpoint identity mismatch: replacement runs are not allowed.");
    }
  }
  if (
    checkpoint &&
    checkpoint.plan.runId === plan.runId && checkpoint.plan.seed === plan.seed &&
    checkpoint.plan.baselineSha === plan.baselineSha &&
    checkpoint.run.planIdentity === planIdentity
  ) {
    const armsByKey = new Map(plan.arms.map((arm) => [arm.key, arm]));
    const resumedPlan = { ...plan, createdAt: checkpoint.plan.createdAt };
    return {
      ...checkpoint,
      plan: resumedPlan,
      run: { ...checkpoint.run, runRoot: plan.runRoot, planIdentity },
      observations: checkpoint.observations.map((observation) => ({
        ...observation,
        arm: armsByKey.get(observation.arm.key) ?? observation.arm,
      })),
    };
  }
  return {
    schema: AGENT_BENCHMARK_SCHEMA,
    kind: "agent_benchmark_result",
    run: { runId: plan.runId, seed: plan.seed, baselineSha: plan.baselineSha, runRoot: plan.runRoot, state: "planned", planIdentity },
    plan,
    observations: [],
    replacements: [],
  };
}

function assertTerminalEvidencePreserved(
  existing: BenchmarkResultFile,
  incoming: BenchmarkResultFile,
): void {
  const incomingByKey = new Map(incoming.observations.map((item) => [item.arm.key, item]));
  const retainedReplacements = incoming.replacements ?? [];
  for (const observation of existing.observations.filter(isTerminal)) {
    const next = incomingByKey.get(observation.arm.key);
    const retained = retainedReplacements.some((replacement) =>
      replacement.armKey === observation.arm.key &&
      sameTerminalEvidence(observation, replacement.observation));
    if ((!next || !sameTerminalEvidence(observation, next)) && !retained) {
      throw new Error(`Benchmark checkpoint terminal evidence mismatch: ${observation.arm.key}`);
    }
  }
}

function sameTerminalEvidence(
  existing: BenchmarkObservation,
  incoming: BenchmarkObservation,
): boolean {
  if (JSON.stringify(incoming) === JSON.stringify(existing)) return true;
  const review = incoming.visualReview;
  if (!review || existing.arm.scenario !== "butler_landing_page" ||
    (existing.visualReview !== null &&
      JSON.stringify(existing.visualReview) !== JSON.stringify(review)) ||
    incoming.evaluation.visualQuality !== review.score ||
    !incoming.evaluation.evaluatorNotes.includes(`visual-review:${review.rubricVersion}`)) {
    return false;
  }
  const normalizedIncoming = {
    ...incoming,
    visualReview: existing.visualReview,
    evaluation: {
      ...incoming.evaluation,
      visualQuality: existing.evaluation.visualQuality,
      evaluatorNotes: incoming.evaluation.evaluatorNotes.filter((note) =>
        !note.startsWith("visual-review:")),
    },
  };
  return JSON.stringify(normalizedIncoming) === JSON.stringify(existing);
}

export function redactBenchmarkResult(result: BenchmarkResultFile): BenchmarkResultFile {
  const plan = redactBenchmarkPlan(result.plan);
  return {
    ...result,
    run: {
      ...result.run,
      runRoot: "<run-root>",
      planIdentity: result.run.planIdentity ?? benchmarkPlanIdentity(result.plan),
    },
    plan,
    observations: result.observations.map((observation) => ({
      ...observation,
      arm: redactBenchmarkArm(observation.arm, result.plan.runRoot),
      adapterVersion: observation.adapterVersion === null ? null : sanitizeText(observation.adapterVersion),
      effectiveConfig: sanitizeEffectiveConfig(observation.effectiveConfig) as BenchmarkObservation["effectiveConfig"],
      diagnostics: observation.diagnostics.map(sanitizeText),
      evidenceRefs: observation.evidenceRefs.map(sanitizeReference),
      changedPaths: observation.changedPaths.map(sanitizeReference),
      tools: {
        ...observation.tools,
        records: observation.tools.records.map((record) => ({
          ...record,
          callId: record.callId === null || record.callId === undefined ? record.callId : sanitizeText(record.callId),
          name: record.name === null ? null : sanitizeText(record.name),
          status: record.status,
        })),
      },
      operations: {
        ...observation.operations,
        tests: {
          ...observation.operations.tests,
          command: observation.operations.tests.command === null ? null : sanitizeText(observation.operations.tests.command),
        },
        build: {
          ...observation.operations.build,
          command: observation.operations.build.command === null ? null : sanitizeText(observation.operations.build.command),
        },
      },
      evaluation: {
        ...observation.evaluation,
        evaluatorNotes: observation.evaluation.evaluatorNotes.map(sanitizeText),
        evidenceRefs: observation.evaluation.evidenceRefs.map(sanitizeReference),
      },
      visualReview: !observation.visualReview ? null : {
        score: observation.visualReview.score,
        reviewerLabel: sanitizeText(observation.visualReview.reviewerLabel),
        rubricVersion: sanitizeText(observation.visualReview.rubricVersion),
      },
    })),
    replacements: result.replacements?.map((replacement) => ({
      ...replacement,
      observation: redactBenchmarkResult({
        ...result,
        observations: [replacement.observation],
        replacements: [],
      }).observations[0]!,
    })),
  };
}

function assertResultIdentity(result: BenchmarkResultFile): string {
  const identity = benchmarkPlanIdentity(result.plan);
  if (
    result.run.runId !== result.plan.runId ||
    result.run.seed !== result.plan.seed ||
    result.run.baselineSha !== result.plan.baselineSha ||
    (result.run.planIdentity !== undefined && result.run.planIdentity !== identity)
  ) {
    throw new Error("Benchmark checkpoint identity mismatch: result does not match its plan.");
  }
  return identity;
}

export function redactBenchmarkPlan(plan: BenchmarkPlan): BenchmarkPlan {
  return {
    ...plan,
    runRoot: "<run-root>",
    sourceRoot: "<source-root>",
    harnessRoot: "<harness-root>",
    ...(plan.provenanceJsonlPath ? { provenanceJsonlPath: "<provenance-jsonl>" } : {}),
    arms: plan.arms.map((arm) => redactBenchmarkArm(arm, plan.runRoot)),
  };
}

function redactBenchmarkArm(arm: BenchmarkArmPlan, runRoot: string): BenchmarkArmPlan {
  const relativePath = (path: string): string => relative(runRoot, path).replaceAll("\\", "/");
  return {
    ...arm,
    effectiveConfig: sanitizeEffectiveConfig(arm.effectiveConfig) as BenchmarkArmPlan["effectiveConfig"],
    sourceRoot: `<${arm.version ?? "source"}-source-root>`,
    outputRoot: relativePath(arm.outputRoot),
    dataRoot: relativePath(arm.dataRoot),
    evidenceRoot: relativePath(arm.evidenceRoot),
    cacheRoot: relativePath(arm.cacheRoot),
  };
}

function sanitizeReference(value: string): string {
  return sanitizeText(value)
    .replace(/^\/?(?:Users|home)\/[^/]+/u, "<private>")
    .replace(/^[A-Z]:\\[^\\]*/u, "<private>");
}

export function createGatedBenchmarkObservation(
  arm: BenchmarkArmPlan,
  preflight: PreflightResult,
): BenchmarkObservation {
  return {
    ...emptyObservation(arm),
    providerDispatchState: "not_dispatched",
    infrastructureGateStage: "pre_adapter",
    effectiveConfig: sanitizeEffectiveConfig({
      ...arm.effectiveConfig,
      ...(preflight.effectiveConfig ?? {}),
    }) as BenchmarkObservation["effectiveConfig"],
    terminalState: "gated",
    gateCode: preflight.gateCode,
    adapterVersion: preflight.version,
    diagnostics: preflight.diagnostic ? [sanitizeText(preflight.diagnostic)] : [],
  };
}

export function createFailureObservation(
  arm: BenchmarkArmPlan,
  diagnostic: string,
): BenchmarkObservation {
  return { ...emptyObservation(arm), terminalState: "failed", diagnostics: [sanitizeText(diagnostic)] };
}

export function sanitizeText(value: string): string {
  return boundedText(value).replace(/\$1/gu, "[REDACTED]").slice(-1_000);
}

export function isTerminal(observation: BenchmarkObservation): boolean {
  return ["accepted", "rejected", "failed", "timed_out", "gated"].includes(observation.terminalState);
}

function emptyObservation(arm: BenchmarkArmPlan): BenchmarkObservation {
  const usage: TokenUsage = { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalTokens: null, modelRequests: null };
  const tools: ToolMetrics = { calls: null, failedCalls: null, records: [] };
  const timing: TimingMetrics = { submittedAtMs: null, firstUsefulOutputAtMs: null, terminalAtMs: null, totalElapsedMs: null };
  return {
    schema: AGENT_BENCHMARK_SCHEMA,
    kind: "agent_benchmark_observation",
    arm,
    terminalState: "failed",
    gateCode: "none",
    adapterVersion: null,
    effectiveConfig: arm.effectiveConfig,
    usage,
    tools,
    timing,
    operations: { userInterventions: null, retries: null, changedFiles: null, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
    evaluation: { accepted: null, factualAccuracy: null, sourceQuality: null, visualQuality: null, resultQuality: null, evaluatorNotes: [], evidenceRefs: [] },
    visualReview: null,
    privacy: { redacted: true, promptLeak: false, credentialLeak: false, rawToolPayloadLeak: false, privatePathLeak: false, hiddenReasoningLeak: false },
    acceptedResultPerToken: null,
    promptHash: null,
    answerHash: null,
    changedPaths: [],
    diagnostics: [],
    evidenceRefs: [],
    providerDispatchState: "not_dispatched",
    infrastructureGateStage: null,
    pairedComparableIdentity: null,
    m1V2: null,
  };
}
