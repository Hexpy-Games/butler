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
import { verifyM1V2AuthoritativeProvenance } from "./m1-v2-provenance.ts";
import { replacementEligibility } from "./paired-contract.ts";

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
  if (input.plan.campaign === "m1-v2" || input.plan.campaign === "m1-v2-paired") {
    let current: NonNullable<BenchmarkPlan["provenance"]>;
    try {
      current = verifyM1V2AuthoritativeProvenance({
        repoRoot: input.plan.harnessRoot,
        jsonlPath: input.plan.provenanceJsonlPath!,
      }).identity;
    } catch (error) {
      throw new Error(`M1 v2 provenance identity mismatch: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (JSON.stringify(current) !== JSON.stringify(input.plan.provenance)) {
      throw new Error("M1 v2 provenance identity mismatch: authority changed after planning.");
    }
  }
  assertAdapterAuthority(input.adapters);
  const checkpoint = await input.store.load();
  const result = resumeOrInitialize(input.plan, checkpoint);
  result.run.state = "preflight";
  await input.store.save(result);
  const platformDiagnostic = benchmarkPlatformGate();
  const sourceContexts = new Map<string, {
    diagnostic: string | null;
    evidenceDiagnostic: string | null;
    evidenceSnapshot: RepositoryEvidenceSnapshot | null;
  }>();
  for (const arm of input.plan.arms) {
    if (sourceContexts.has(arm.sourceRoot)) continue;
    const sourceState = sourceIntegrity(arm.sourceRoot);
    const sourceValid = platformDiagnostic === null &&
      sourceState.commit === arm.sourceRevision && sourceState.status === "";
    const context = {
      diagnostic: sourceValid ? null : platformDiagnostic ?? (
        sourceState.commit === null
          ? "Source checkout is not a readable Git worktree at the pinned baseline."
          : "Pinned source checkout is not clean at the required baseline."
      ),
      evidenceDiagnostic: null as string | null,
      evidenceSnapshot: null as RepositoryEvidenceSnapshot | null,
    };
    if (sourceValid) {
      try {
        const identity = arm.version ? `-${arm.version}` : "";
        context.evidenceSnapshot = materializeRepositoryEvidence(
          arm.sourceRoot,
          `${input.plan.runRoot}/evidence/repository${identity}`,
        );
      } catch (error) {
        context.evidenceDiagnostic = errorMessage(error);
      }
    }
    sourceContexts.set(arm.sourceRoot, context);
  }
  if (input.plan.campaign !== "m1-v2-paired") {
    const snapshot = sourceContexts.get(input.plan.sourceRoot)?.evidenceSnapshot;
    if (snapshot) {
      result.plan.repositoryEvidence = {
        relativeRoot: "evidence/repository",
        files: snapshot.files,
        sha256: snapshot.sha256,
      };
      await input.store.save(result);
    }
  }
  const notScheduled: PreflightResult = {
    available: false, executable: null, version: null, authenticated: null,
    configVerified: false, gateCode: "measurement_unavailable",
    diagnostic: "External adapter is contract-only for the M1 v2 Butler campaign.",
  };
  const preflight = {
    butler: await input.adapters.butler.preflight(),
    hermes: input.plan.campaign !== "cross-agent-pilot" ? notScheduled : await input.adapters.hermes.preflight(),
    opencode: input.plan.campaign !== "cross-agent-pilot" ? notScheduled : await input.adapters.opencode.preflight(),
  } satisfies Record<"butler" | "hermes" | "opencode", PreflightResult>;
  if (input.mode === "preflight-only") {
    result.observations = input.plan.arms.map((arm) => {
      const context = sourceContexts.get(arm.sourceRoot)!;
      const sourceDiagnostic = context.diagnostic;
      const evidenceDiagnostic = context.evidenceDiagnostic;
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
    if (prior && prior.arm.fixtureHash === arm.fixtureHash && isTerminal(prior)) {
      const replacement = replacementEligibility({
        providerDispatchStarted: (prior.m1V2?.agentAttempts.length ?? 0) > 0 ||
          (prior.usage.modelRequests ?? 0) > 0,
        providerOutputObserved: prior.timing.firstUsefulOutputAtMs !== null ||
          prior.answerHash !== null,
      });
      const alreadyReplaced = result.replacements?.some((item) => item.armKey === arm.key) ?? false;
      if (input.plan.campaign !== "m1-v2-paired" || !replacement.allowed || alreadyReplaced ||
          prior.gateCode !== "measurement_unavailable") continue;
      result.replacements ??= [];
      result.replacements.push({ armKey: arm.key, reason: replacement.reason as "pre_provider_infrastructure_replacement", observation: prior });
      result.observations = result.observations.filter((item) => item.arm.key !== arm.key);
      completed.delete(arm.key);
    }
    const sourceContext = sourceContexts.get(arm.sourceRoot)!;
    const observation = await runBenchmarkArm({
      arm,
      adapter: input.adapters[arm.agent],
      preflight: preflight[arm.agent],
      signal: input.signal,
      planRunRoot: input.plan.runRoot,
      harnessRoot: input.plan.harnessRoot,
      landingValidator: input.landingValidator,
      evidenceSnapshot: sourceContext.evidenceSnapshot,
      sourceDiagnostic: sourceContext.diagnostic,
      evidenceDiagnostic: sourceContext.evidenceDiagnostic,
    });
    const existingIndex = result.observations.findIndex((value) => value.arm.key === arm.key);
    if (existingIndex >= 0) result.observations[existingIndex] = observation;
    else result.observations.push(observation);
    completed.set(arm.key, observation);
    await input.store.save(result);
    if (input.plan.campaign !== "cross-agent-pilot" && observation.terminalState === "gated") break;
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
