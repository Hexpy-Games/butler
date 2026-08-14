import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { benchmarkPlanIdentity } from "./planning.ts";
import { hasM1V2DurableAuthority, recoverM1V2DurableProjection, verifyM1V2DurableProjection } from "./m1-v2-evidence-export.ts";
import { emptyM1V2Repetition } from "./m1-v2-aggregate.ts";
import { getBenchmarkFixture } from "./fixtures.ts";

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
  if (input.plan.campaign === "m1-v2" || input.plan.campaign === "m1-v2-paired" || input.plan.campaign === "m1-v2-after-only") {
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
        relativeRoot: input.plan.campaign === "m1-v2-after-only"
          ? "evidence/repository-after"
          : "evidence/repository",
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
      verifyTerminalDurableEvidence(input.plan, prior);
      if (prior.gateCode === "measurement_unavailable" && prior.m1V2 &&
          (prior.providerDispatchState === "provider_dispatched" || prior.providerDispatchState === "provider_output_observed")) break;
      const replacement = replacementEligibility({
        providerDispatchState: prior.providerDispatchState ?? "adapter_entered",
        infrastructureGateStage: prior.infrastructureGateStage ?? null,
      });
      const alreadyReplaced = result.replacements?.some((item) => item.armKey === arm.key) ?? false;
      if ((input.plan.campaign !== "m1-v2-paired" && input.plan.campaign !== "m1-v2-after-only") ||
          !replacement.allowed || alreadyReplaced ||
          prior.gateCode !== "measurement_unavailable") continue;
      result.replacements ??= [];
      result.replacements.push({ armKey: arm.key, reason: replacement.reason as "pre_provider_infrastructure_replacement", observation: prior });
      result.observations = result.observations.filter((item) => item.arm.key !== arm.key);
      completed.delete(arm.key);
    }
    if (!completed.has(arm.key) && (input.plan.campaign === "m1-v2" || input.plan.campaign === "m1-v2-paired" || input.plan.campaign === "m1-v2-after-only")) {
      const planIdentity = benchmarkPlanIdentity(input.plan);
      const temporary = existsSync(join(arm.evidenceRoot, "sc01-public-evidence.json.tmp"));
      const evidence = existsSync(join(arm.evidenceRoot, "sc01-public-evidence.json"));
      const authority = hasM1V2DurableAuthority({ runRoot: input.plan.runRoot, planIdentity, armKey: arm.key });
      if (temporary || evidence || authority) {
        const recovered = recoverOrphanedDurableEvidence(input.plan, arm, preflight[arm.agent],
          !temporary && evidence && authority);
        result.observations.push(recovered); completed.set(arm.key, recovered);
        await input.store.save(result);
        break;
      }
    }
    const sourceContext = sourceContexts.get(arm.sourceRoot)!;
    const observation = await runBenchmarkArm({
      arm,
      adapter: input.adapters[arm.agent],
      preflight: preflight[arm.agent],
      signal: input.signal,
      evidenceContext: { planIdentity: benchmarkPlanIdentity(input.plan), runRoot: input.plan.runRoot },
      harnessRoot: input.plan.harnessRoot,
      landingValidator: input.landingValidator,
      evidenceSnapshot: sourceContext.evidenceSnapshot,
      sourceDiagnostic: sourceContext.diagnostic,
      evidenceDiagnostic: sourceContext.evidenceDiagnostic,
      pairedAuthReceipt: input.plan.pairedCampaign?.authReceipt ?? input.plan.afterOnlyCampaign?.authReceipt,
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

function recoverOrphanedDurableEvidence(plan: BenchmarkPlan, arm: import("./contracts.ts").BenchmarkArmPlan, preflight: PreflightResult,
  completeCommit: boolean): import("./contracts.ts").BenchmarkObservation {
  const fixture = getBenchmarkFixture(arm.scenario, plan.harnessRoot);
  let verified: ReturnType<typeof recoverM1V2DurableProjection> | null = null;
  let reason = "sc01_export_recovery_incomplete";
  if (completeCommit) {
    try {
      verified = recoverM1V2DurableProjection({ planIdentity: benchmarkPlanIdentity(plan), runRoot: plan.runRoot, arm, fixture });
      reason = "sc01_export_recovered_after_checkpoint_crash";
    } catch {
      reason = "sc01_export_recovery_verification_failed";
    }
  }
  const observation = createGatedBenchmarkObservation(arm, { ...preflight, available: false, configVerified: false,
    gateCode: "measurement_unavailable", diagnostic: reason });
  observation.providerDispatchState = "provider_dispatched";
  observation.infrastructureGateStage = null;
  observation.m1V2 = verified
    ? { ...emptyM1V2Repetition(fixture.m1V2!.armId, arm.repetition, "gated", reason),
        ...verified.arithmetic, targetEvidenceIdentity: { sessionId: verified.identity.sessionId, turnId: verified.identity.turnId },
        durableEvidence: { handle: verified.handle, sha256: verified.sha256, identity: verified.identity } }
    : emptyM1V2Repetition(fixture.m1V2!.armId, arm.repetition, "gated", reason);
  return observation;
}

function verifyTerminalDurableEvidence(plan: BenchmarkPlan, observation: import("./contracts.ts").BenchmarkObservation): void {
  const durable = observation.m1V2?.durableEvidence;
  if (!durable) {
    const postDispatch = observation.providerDispatchState === "provider_dispatched" || observation.providerDispatchState === "provider_output_observed";
    const safeOrphanGate = observation.m1V2?.reasons.length === 1 && observation.m1V2.reasons[0]?.startsWith("sc01_export_recover");
    if ((plan.campaign === "m1-v2" || plan.campaign === "m1-v2-paired" || plan.campaign === "m1-v2-after-only") && observation.m1V2 && postDispatch && !safeOrphanGate) {
      throw new Error("sc01_export_resume_evidence_missing");
    }
    return;
  }
  const fixture = getBenchmarkFixture(observation.arm.scenario, plan.harnessRoot);
  if (!observation.m1V2?.targetEvidenceIdentity) throw new Error("sc01_export_resume_target_identity_missing");
  verifyM1V2DurableProjection({ planIdentity: benchmarkPlanIdentity(plan), runRoot: plan.runRoot, arm: observation.arm, fixture,
    target: observation.m1V2.targetEvidenceIdentity, durable: { handle: durable.handle, sha256: durable.sha256, identity: durable.identity } });
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
