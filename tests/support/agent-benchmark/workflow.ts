import type {
  AgentAdapter,
  BenchmarkPlan,
  BenchmarkResultFile,
  PreflightResult,
} from "./contracts.ts";
import {
  createGatedBenchmarkObservation,
  isTerminal,
  resumeOrInitialize,
  type BenchmarkCheckpointStore,
} from "./checkpoint.ts";
import { benchmarkPlatformGate, sourceIntegrity, validateBenchmarkPlan } from "./isolation.ts";
import { materializeRepositoryEvidence, type RepositoryEvidenceSnapshot } from "./repository-evidence.ts";
import { runBenchmarkArm, type LandingValidator } from "./workflow-arm.ts";

export { runtimeInstructions } from "./workflow-arm.ts";
export type { LandingValidator } from "./workflow-arm.ts";

export { createFileCheckpointStore, createGatedBenchmarkObservation } from "./checkpoint.ts";
export { redactBenchmarkPlan, redactBenchmarkResult } from "./checkpoint.ts";
export type { BenchmarkCheckpointStore } from "./checkpoint.ts";

export interface RunAgentBenchmarkInput {
  plan: BenchmarkPlan;
  adapters: Readonly<Record<"butler" | "hermes" | "opencode", AgentAdapter>>;
  store: BenchmarkCheckpointStore;
  signal: AbortSignal;
  landingValidator: LandingValidator;
  mode: "preflight-only" | "execute";
}

export interface WorkflowRunResult {
  result: BenchmarkResultFile;
  preflight: Readonly<Record<"butler" | "hermes" | "opencode", PreflightResult>>;
}

export async function runAgentBenchmark(input: RunAgentBenchmarkInput): Promise<WorkflowRunResult> {
  validateBenchmarkPlan(input.plan);
  assertAdapterAuthority(input.adapters);
  const checkpoint = await input.store.load();
  const result = resumeOrInitialize(input.plan, checkpoint);
  result.run.state = "preflight";
  await input.store.save(result);
  const sourceState = sourceIntegrity(input.plan.sourceRoot);
  const platformDiagnostic = benchmarkPlatformGate();
  const sourceValid = platformDiagnostic === null &&
    sourceState.commit === input.plan.baselineSha && sourceState.status === "";
  let evidenceSnapshot: RepositoryEvidenceSnapshot | null = null;
  let evidenceDiagnostic: string | null = null;
  const sourceDiagnostic = sourceValid ? null : platformDiagnostic ?? (
    sourceState.commit === null
      ? "Source checkout is not a readable Git worktree at the pinned baseline."
      : "Pinned source checkout is not clean at the required baseline."
  );
  if (sourceValid) {
    try {
      evidenceSnapshot = materializeRepositoryEvidence(
        input.plan.sourceRoot,
        `${input.plan.runRoot}/evidence/repository`,
      );
      result.plan.repositoryEvidence = {
        relativeRoot: "evidence/repository",
        files: evidenceSnapshot.files,
        sha256: evidenceSnapshot.sha256,
      };
      await input.store.save(result);
    } catch (error) {
      evidenceDiagnostic = errorMessage(error);
    }
  }
  const notScheduled: PreflightResult = {
    available: false, executable: null, version: null, authenticated: null,
    configVerified: false, gateCode: "measurement_unavailable",
    diagnostic: "External adapter is contract-only for the M1 v2 Butler campaign.",
  };
  const preflight = {
    butler: await input.adapters.butler.preflight(),
    hermes: input.plan.campaign === "m1-v2" ? notScheduled : await input.adapters.hermes.preflight(),
    opencode: input.plan.campaign === "m1-v2" ? notScheduled : await input.adapters.opencode.preflight(),
  } satisfies Record<"butler" | "hermes" | "opencode", PreflightResult>;
  if (input.mode === "preflight-only") {
    result.observations = input.plan.arms.map((arm) => {
      if (sourceDiagnostic || (evidenceDiagnostic && arm.scenario === "butler_landing_page")) {
        return createGatedBenchmarkObservation(arm, {
          available: false,
          executable: preflight[arm.agent].executable,
          version: preflight[arm.agent].version,
          authenticated: preflight[arm.agent].authenticated,
          configVerified: false,
          gateCode: "configuration_unverifiable",
          diagnostic: sourceDiagnostic ?? evidenceDiagnostic ?? "Landing evidence is unavailable.",
        });
      }
      const agentPreflight = preflight[arm.agent];
      return createGatedBenchmarkObservation(arm, agentPreflight.gateCode === "none"
        ? {
            ...agentPreflight,
            available: false,
            configVerified: false,
            gateCode: "measurement_unavailable",
            diagnostic: "Pilot is preflight-only; pass --execute-available to run benchmark arms.",
          }
        : agentPreflight);
    });
    result.run.state = "reported";
    await input.store.save(result);
    return { result, preflight };
  }
  result.run.state = "running";
  await input.store.save(result);
  const completed = new Map(result.observations.map((observation) => [observation.arm.key, observation]));
  for (const arm of input.plan.arms) {
    if (input.signal.aborted) break;
    const prior = completed.get(arm.key);
    if (prior && prior.arm.fixtureHash === arm.fixtureHash && isTerminal(prior)) continue;
    const observation = await runBenchmarkArm({
      arm,
      adapter: input.adapters[arm.agent],
      preflight: preflight[arm.agent],
      signal: input.signal,
      planRunRoot: input.plan.runRoot,
      landingValidator: input.landingValidator,
      evidenceSnapshot,
      sourceDiagnostic,
      evidenceDiagnostic,
    });
    const existingIndex = result.observations.findIndex((value) => value.arm.key === arm.key);
    if (existingIndex >= 0) result.observations[existingIndex] = observation;
    else result.observations.push(observation);
    completed.set(arm.key, observation);
    await input.store.save(result);
    if (input.plan.campaign === "m1-v2" && observation.terminalState === "gated") break;
  }
  result.run.state = result.observations.length === input.plan.arms.length ? "reported" : "running";
  await input.store.save(result);
  return { result, preflight };
}

function assertAdapterAuthority(
  adapters: Readonly<Record<"butler" | "hermes" | "opencode", AgentAdapter>>,
): void {
  for (const agent of ["butler", "hermes", "opencode"] as const) {
    if (adapters[agent].agent !== agent) throw new Error(`Adapter authority mismatch for ${agent}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
