import { readOperationalMetricEvents } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { AdapterRunInput, AdapterRunResult } from "./contracts.ts";
import { readM1V2DbEvidence } from "./m1-v2-db-evidence.ts";
import { materializeM1V2EvidenceExport } from "./m1-v2-evidence-export.ts";
import { FINAL_ACTIVATION, FINAL_AFTER_REVISION, FINAL_BEFORE_REVISION } from "./paired-contract.ts";
import { materializeM1V2RuntimeActivationReceipt } from "./m1-v2-activation-receipt.ts";
import type { ProviderRequestObservation } from "../../e2e/btcc-r3-electron/provider-observation-proxy.ts";
import { join, relative } from "node:path";

const M1_FLAGS = [
  "BUTLER_M1_V2_SEGMENT_ATTRIBUTION",
  "BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE",
  "BUTLER_M1_V2_EXACT_ONCE_REPLAY",
  "BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT",
] as const;
const CONTINUATION_OVERRIDE_PREFIX = "BUTLER_M1_V2_CONTINUATION_";

export async function collectButlerM1V2Evidence(input: {
  benchmark: AdapterRunInput;
  evidence: Record<string, unknown>;
  attemptStartedAtMs: number;
}): Promise<NonNullable<AdapterRunResult["m1V2Evidence"]>> {
  const run = recordValue(input.evidence.run);
  const dataRoot = typeof run?.dataRoot === "string" ? run.dataRoot : null;
  const workspaceRoot = typeof run?.workspaceRoot === "string" ? run.workspaceRoot : null;
  const target = (Array.isArray(input.evidence.observations) ? input.evidence.observations : [])
    .map(recordValue).find((row) => row?.stepId === input.benchmark.fixture.m1V2?.targetStepId);
  const turnId = typeof target?.turnId === "string" ? target.turnId : null;
  if (!dataRoot || !workspaceRoot || !target || !turnId || !input.benchmark.fixture.m1V2) {
    throw new Error("M1 v2 product evidence omitted required run identity");
  }
  const metrics = readOperationalMetricEvents({ butlerData: dataRoot });
  const providerRequests = Array.isArray(input.evidence.providerRequests)
    ? input.evidence.providerRequests.map(recordValue).filter((row): row is Record<string, unknown> => row !== null)
    : [];
  const sessionId = typeof target.sessionId === "string" ? target.sessionId : null;
  if (!sessionId) throw new Error("M1 v2 product evidence omitted Session identity");
  const db = readM1V2DbEvidence(dataRoot, turnId);
  const activationReceipt = input.benchmark.arm.version && input.benchmark.arm.activation
    ? materializeM1V2RuntimeActivationReceipt({
        runRoot: input.benchmark.benchmarkEvidence.runRoot,
        dataRoot, evidenceRoot: input.benchmark.arm.evidenceRoot, turnId,
        version: input.benchmark.arm.version,
        sourceRevision: input.benchmark.arm.sourceRevision,
        declaredActivation: input.benchmark.arm.activation,
        providerRequests: providerRequests as unknown as ProviderRequestObservation[],
      })
    : undefined;
  const landingValidation = input.benchmark.fixture.m1V2.armId === "landing-cold"
    ? await validateLandingEvidence(input.benchmark.arm.evidenceRoot, workspaceRoot)
    : null;
  const exported = materializeM1V2EvidenceExport({
    runRoot: input.benchmark.benchmarkEvidence.runRoot,
    evidenceRoot: input.benchmark.arm.evidenceRoot,
    identity: {
      planIdentity: input.benchmark.benchmarkEvidence.planIdentity,
      sourceRevision: input.benchmark.arm.sourceRevision,
      fixtureHash: input.benchmark.arm.fixtureHash,
      armKey: input.benchmark.arm.key,
      armId: input.benchmark.fixture.m1V2.armId,
      repetition: input.benchmark.arm.repetition,
      block: input.benchmark.arm.block ?? null,
      stepId: input.benchmark.fixture.m1V2.targetStepId,
      version: input.benchmark.arm.version ?? null,
      pairId: input.benchmark.arm.pairId ?? null,
      armOrder: input.benchmark.arm.order,
      sessionId,
      turnId,
      expectedProviderId: "openai-codex",
      expectedModelRef: input.benchmark.fixture.m1V2.scenario.model!,
      expectedRouteId: "openai-codex-responses",
      expectedCacheBoundaryRevision: input.benchmark.fixture.m1V2.scenario.cacheBoundaryEvidence?.expectedRevision ?? "current",
      membershipSha256: null,
    },
    target,
    observations: (Array.isArray(input.evidence.observations) ? input.evidence.observations : []).map(recordValue).filter((row): row is Record<string, unknown> => row !== null),
    providerRequests,
    metrics,
  });
  return {
    evidence: input.evidence,
    metrics,
    db,
    landingValidation,
    sourceRevision: input.benchmark.arm.sourceRevision ?? "",
    attemptStartedAtMs: input.attemptStartedAtMs,
    exportHandle: exported.handle,
    exportRunRoot: input.benchmark.benchmarkEvidence.runRoot,
    exportPlanIdentity: input.benchmark.benchmarkEvidence.planIdentity,
    exportSha256: exported.sha256,
    exportPath: exported.absolutePath,
    exportIdentity: exported.evidence.identity,
    ...(activationReceipt ? { activationReceipt } : {}),
    ...(activationReceipt ? { activationReceiptHandle: relative(
      input.benchmark.benchmarkEvidence.runRoot,
      join(input.benchmark.arm.evidenceRoot, "m1-v2-runtime-activation-receipt.json"),
    ).replaceAll("\\", "/") } : {}),
  };
}

async function validateLandingEvidence(runRoot: string, workspaceRoot: string) {
  const { validateM1V2Landing } = await import("./m1-v2-landing-quality.ts");
  return validateM1V2Landing({ runRoot, workspaceRoot });
}

export async function withButlerM1V2Environment<T>(
  input: AdapterRunInput,
  run: () => Promise<T>,
): Promise<T> {
  if (!input.fixture.m1V2) return run();
  const version = input.arm.version;
  if (version) {
    const expectedRevision = version === "before" ? FINAL_BEFORE_REVISION : FINAL_AFTER_REVISION;
    if (input.arm.sourceRevision !== expectedRevision ||
        JSON.stringify(input.arm.activation) !== JSON.stringify(FINAL_ACTIVATION[version])) {
      throw new Error("m1_activation_source_identity_mismatch");
    }
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(CONTINUATION_OVERRIDE_PREFIX)) {
      throw new Error("m1_continuation_default_override_forbidden");
    }
  }
  const previous = new Map<string, string | undefined>([
    ...M1_FLAGS.map((name) => [name, process.env[name]] as const),
    ["BUTLER_M1_SOURCE_REVISION", process.env.BUTLER_M1_SOURCE_REVISION],
    ["BUTLER_MODEL_API_RETRY_ATTEMPTS", process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS],
  ]);
  process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "1";
  const enabled = version === "after";
  process.env.BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE = enabled ? "1" : "0";
  process.env.BUTLER_M1_V2_EXACT_ONCE_REPLAY = enabled ? "1" : "0";
  process.env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT = enabled ? "1" : "0";
  if (input.arm.sourceRevision) process.env.BUTLER_M1_SOURCE_REVISION = input.arm.sourceRevision;
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "3";
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
