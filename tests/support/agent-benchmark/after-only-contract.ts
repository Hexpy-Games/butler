import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BenchmarkObservation, BenchmarkPlan, BenchmarkResultFile } from "./contracts.ts";
import type { M1V2ArmId } from "./m1-v2-types.ts";
import type { M1V2ProvenanceIdentity } from "./m1-v2-types.ts";
import type { PreparedButlerResourceIdentity } from "./prepared-butler-resource.ts";
import {
  FINAL_ACTIVATION,
  FINAL_BEFORE_REVISION,
  FINAL_EXECUTION,
  type M1V2ActivationIdentity,
  type PairedExecutionContract,
  type PairedStepIdentity,
  type ProviderAuthPreflight,
} from "./paired-contract.ts";
import { pairedObservationIdentityMatches } from "./paired-observation-identity.ts";
import { pairedMetricRowForObservation, type PairedMetricRow } from "./paired-evaluation.ts";

export const AFTER_ONLY_AFTER_REVISION = "761f8de091193a1a587894bf142e7d4a5ce05a73" as const;
export const AFTER_ONLY_BASE_REVISION = "251f529af72e611096e6ca80a58b85c3e32a7903" as const;

export interface FrozenBeforeCell {
  key: string;
  pairId: string;
  fixture: M1V2ArmId;
  repetition: number;
  block: number;
  fixtureSha256: string;
  terminalState: BenchmarkObservation["terminalState"];
  gateCode: BenchmarkObservation["gateCode"];
  evidenceIdentitySha256: string | null;
  identitySha256: string;
  comparison: PairedMetricRow | null;
}

export interface AfterOnlyCampaignContract {
  schema: "butler.agent-benchmark.after-only-contract.v1";
  frozenBefore: {
    manifestSha256: string;
    resultSha256: string;
    planIdentity: string;
    acceptedCellIdentities: readonly string[];
    cells: readonly FrozenBeforeCell[];
  };
  after: {
    baseRevision: typeof AFTER_ONLY_BASE_REVISION;
    revision: typeof AFTER_ONLY_AFTER_REVISION;
    compatibilitySha256: string;
    platform: string;
    mode: "bundled_agent_release";
    preparedResource: PreparedButlerResourceIdentity;
    activation: M1V2ActivationIdentity;
  };
  execution: PairedExecutionContract;
  authReceipt: ProviderAuthPreflight;
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>;
  provenance: M1V2ProvenanceIdentity;
  steps: readonly PairedStepIdentity[];
  identity: string;
}

export async function readAfterOnlyCampaignContract(input: {
  manifestPath: string;
  resultPath: string;
  manifestSha256: string;
  resultSha256: string;
  afterCompatibilitySha256: string;
  afterPreparedResource: PreparedButlerResourceIdentity;
  platform: string;
  execution: PairedExecutionContract;
  authReceipt: ProviderAuthPreflight;
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>;
  provenance: M1V2ProvenanceIdentity;
}): Promise<AfterOnlyCampaignContract> {
  const manifestBytes = readFileSync(input.manifestPath);
  const resultBytes = readFileSync(input.resultPath);
  if (sha(manifestBytes) !== input.manifestSha256 || sha(resultBytes) !== input.resultSha256) {
    throw new Error("Frozen BEFORE manifest/result hash mismatch.");
  }
  let manifest: BenchmarkPlan;
  let result: BenchmarkResultFile;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as BenchmarkPlan;
    result = JSON.parse(resultBytes.toString("utf8")) as BenchmarkResultFile;
  } catch {
    throw new Error("Frozen BEFORE manifest/result is unreadable.");
  }
  const { benchmarkPlanIdentity } = await import("./planning.ts");
  let semanticIdentity: string;
  try {
    semanticIdentity = benchmarkPlanIdentity(manifest);
  } catch {
    throw new Error("Frozen BEFORE manifest semantic identity mismatch.");
  }
  if (semanticIdentity !== manifest.planIdentity || semanticIdentity !== result.run.planIdentity) {
    throw new Error("Frozen BEFORE manifest semantic identity mismatch.");
  }
  const cells = validateFrozenBefore(manifest, result, input.fixtureHashes);
  const after = {
    version: "after" as const,
    revision: AFTER_ONLY_AFTER_REVISION,
    compatibilitySha256: input.afterCompatibilitySha256,
    platform: input.platform,
    mode: "bundled_agent_release" as const,
    preparedResource: input.afterPreparedResource,
    activation: FINAL_ACTIVATION.after,
  };
  const steps = canonicalCells().map((cell, order): PairedStepIdentity => ({
    key: `${cell.pairId}:after`, version: "after", fixture: cell.fixture,
    repetition: cell.repetition, block: order, order, pairId: cell.pairId,
    fixtureSha256: input.fixtureHashes[cell.fixture], source: after,
  }));
  const stable = {
    schema: "butler.agent-benchmark.after-only-contract.v1" as const,
    frozenBefore: {
      manifestSha256: input.manifestSha256,
      resultSha256: input.resultSha256,
      planIdentity: result.run.planIdentity!,
      acceptedCellIdentities: cells.filter((cell) => cell.terminalState === "accepted").map(cellIdentity),
      cells,
    },
    after: { baseRevision: AFTER_ONLY_BASE_REVISION, revision: after.revision, compatibilitySha256: after.compatibilitySha256,
      platform: after.platform, mode: after.mode, preparedResource: after.preparedResource,
      activation: after.activation },
    execution: input.execution, authReceipt: input.authReceipt,
    fixtureHashes: input.fixtureHashes, provenance: input.provenance, steps,
  };
  const contract = { ...stable, identity: digest(stable) };
  validateAfterOnlyCampaignContract(contract);
  return contract;
}

export function validateAfterOnlyCampaignContract(contract: AfterOnlyCampaignContract): void {
  const { identity, ...stable } = contract;
  const expectedOrder = canonicalCells();
  if (identity !== digest(stable) || contract.after.baseRevision !== AFTER_ONLY_BASE_REVISION ||
      contract.after.revision !== AFTER_ONLY_AFTER_REVISION ||
      contract.after.preparedResource.sourceRevision !== AFTER_ONLY_AFTER_REVISION ||
      contract.after.preparedResource.sourceCompatibilitySha256 !== contract.after.compatibilitySha256 ||
      JSON.stringify(contract.after.activation) !== JSON.stringify(FINAL_ACTIVATION.after) ||
      JSON.stringify(contract.execution) !== JSON.stringify(FINAL_EXECUTION) ||
      contract.steps.length !== 12 || contract.frozenBefore.cells.length !== 12 ||
      ![contract.frozenBefore.manifestSha256, contract.frozenBefore.resultSha256, contract.frozenBefore.planIdentity,
        contract.after.compatibilitySha256, contract.after.preparedResource.manifestSha256,
        contract.after.preparedResource.dependencyClosureSha256, contract.after.preparedResource.resourceSha256,
        contract.after.preparedResource.archiveSha256].every(isSha) ||
      contract.steps.some((step, index) => step.version !== "after" || step.order !== index ||
        step.fixture !== expectedOrder[index]!.fixture || step.repetition !== expectedOrder[index]!.repetition ||
        step.fixtureSha256 !== contract.fixtureHashes[step.fixture] || step.source.revision !== AFTER_ONLY_AFTER_REVISION) ||
      contract.frozenBefore.cells.some((cell, index) => cell.fixture !== expectedOrder[index]!.fixture ||
        cell.repetition !== expectedOrder[index]!.repetition || cell.pairId !== expectedOrder[index]!.pairId ||
        cell.key !== `${expectedOrder[index]!.pairId}:before` ||
        (expectedOrder[index]!.accepted
          ? cell.terminalState !== "accepted" || cell.gateCode !== "none" || !cell.comparison
          : cell.terminalState !== "gated" || cell.gateCode !== "measurement_unavailable" || cell.comparison !== null) ||
        (expectedOrder[index]!.accepted ? !isSha(cell.evidenceIdentitySha256) : cell.evidenceIdentitySha256 !== null) ||
        cell.identitySha256 !== cellIdentity(cell)) ||
      JSON.stringify(contract.frozenBefore.acceptedCellIdentities) !== JSON.stringify(
        contract.frozenBefore.cells.filter((cell) => cell.terminalState === "accepted").map(cellIdentity))) {
    throw new Error("AFTER-only campaign contract identity mismatch.");
  }
}

function validateFrozenBefore(manifest: BenchmarkPlan, result: BenchmarkResultFile,
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>): FrozenBeforeCell[] {
  if (manifest.schema !== "butler.agent-benchmark.v1" || manifest.kind !== "agent_benchmark_plan" ||
      result.schema !== manifest.schema || result.kind !== "agent_benchmark_result" ||
      !result.run.planIdentity || result.run.planIdentity !== manifest.planIdentity ||
      JSON.stringify(result.plan) !== JSON.stringify(manifest)) {
    throw new Error("Frozen BEFORE manifest/result identity mismatch.");
  }
  const beforeArms = manifest.arms.filter((arm) => arm.version === "before");
  const expectedOrder = canonicalCells();
  if (beforeArms.length !== 12 || beforeArms.some((arm, index) => arm.scenario !== expectedOrder[index]!.fixture ||
      arm.repetition !== expectedOrder[index]!.repetition || arm.key !== `${expectedOrder[index]!.pairId}:before` ||
      arm.pairId !== expectedOrder[index]!.pairId || arm.sourceRevision !== FINAL_BEFORE_REVISION ||
      arm.fixtureHash !== fixtureHashes[arm.scenario as M1V2ArmId] ||
      JSON.stringify(arm.activation) !== JSON.stringify(FINAL_ACTIVATION.before) ||
      JSON.stringify(arm.pairedExecution) !== JSON.stringify(FINAL_EXECUTION))) {
    throw new Error("Frozen BEFORE cell identity/order mismatch.");
  }
  const byKey = new Map(result.observations.map((observation) => [observation.arm.key, observation]));
  if (result.observations.length !== 12 || byKey.size !== 12 ||
      result.observations.some((observation, index) => observation.arm.key !== beforeArms[index]?.key)) {
    throw new Error("Frozen BEFORE observation identity/cardinality mismatch.");
  }
  return beforeArms.map((arm, index) => {
    const observation = byKey.get(arm.key);
    if (!observation || !pairedObservationIdentityMatches(arm, observation.arm) ||
        !["accepted", "rejected", "failed", "timed_out", "gated"].includes(observation.terminalState)) {
      throw new Error("Frozen BEFORE observation identity/cardinality mismatch.");
    }
    const expected = expectedOrder[index]!;
    const comparison = observation.terminalState === "accepted" ? pairedMetricRowForObservation(observation) : null;
    if (observation.terminalState === "accepted" && !comparison) {
      throw new Error("Frozen BEFORE accepted comparison identity is unavailable.");
    }
    if (observation.terminalState !== "accepted" &&
        (observation.terminalState !== "gated" || observation.gateCode !== "measurement_unavailable")) {
      throw new Error("Frozen BEFORE non-accepted cell must remain explicitly measurement_unavailable.");
    }
    const evidenceIdentitySha256 = observation.terminalState === "accepted"
      ? validateFrozenDurableIdentity(observation, result.run.planIdentity!)
      : null;
    const base = { key: arm.key, pairId: arm.pairId!, fixture: expected.fixture, repetition: expected.repetition,
      block: arm.block!, fixtureSha256: arm.fixtureHash, terminalState: observation.terminalState,
      gateCode: observation.gateCode, evidenceIdentitySha256, comparison };
    return { ...base, identitySha256: cellIdentity(base) };
  });
}

function canonicalCells(): Array<{ fixture: M1V2ArmId; repetition: number; pairId: string; accepted: boolean }> {
  const accepted = new Set(["direct-cold:1", "direct-warm:1", "current-web-cold:1",
    "direct-cold:2", "direct-warm:2", "direct-cold:3", "direct-warm:3", "current-web-cold:3"]);
  const cells: Array<{ fixture: M1V2ArmId; repetition: number; pairId: string; accepted: boolean }> = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    for (const fixture of ["direct-cold", "direct-warm", "current-web-cold", "landing-cold"] as const) {
      cells.push({ fixture, repetition, pairId: `${fixture}:rep-${repetition}`, accepted: accepted.has(`${fixture}:${repetition}`) });
    }
  }
  return cells;
}

function cellIdentity(cell: Omit<FrozenBeforeCell, "identitySha256">): string {
  return digest({ key: cell.key, pairId: cell.pairId, fixture: cell.fixture, repetition: cell.repetition,
    block: cell.block, fixtureSha256: cell.fixtureSha256, terminalState: cell.terminalState,
    gateCode: cell.gateCode, evidenceIdentitySha256: cell.evidenceIdentitySha256, comparison: cell.comparison });
}
function validateFrozenDurableIdentity(observation: BenchmarkObservation, planIdentity: string): string {
  const durable = observation.m1V2?.durableEvidence;
  const target = observation.m1V2?.targetEvidenceIdentity;
  const identity = durable?.identity;
  const arm = observation.arm;
  if (!durable || !identity || !target || !isSha(durable.sha256) || !isSha(identity.membershipSha256) ||
      identity.planIdentity !== planIdentity || identity.sourceRevision !== arm.sourceRevision ||
      identity.fixtureHash !== arm.fixtureHash || identity.armKey !== arm.key || identity.armId !== arm.scenario ||
      identity.repetition !== arm.repetition || identity.block !== arm.block || identity.version !== "before" ||
      identity.pairId !== arm.pairId || identity.armOrder !== arm.order || identity.sessionId !== target.sessionId ||
      identity.turnId !== target.turnId || identity.expectedProviderId !== "openai-codex" ||
      identity.expectedModelRef !== "openai/gpt-5.6-sol" || identity.expectedRouteId !== "openai-codex-responses") {
    throw new Error("Frozen BEFORE durable evidence semantic identity mismatch.");
  }
  return digest({ sha256: durable.sha256, identity });
}
function isSha(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
