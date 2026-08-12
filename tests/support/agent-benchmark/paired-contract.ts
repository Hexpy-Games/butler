import { createHash } from "node:crypto";
import type { M1V2ArmId } from "./m1-v2-types.ts";
import type { PreparedButlerResourceIdentity } from "./prepared-butler-resource.ts";
import type { M1V2ProvenanceIdentity } from "./m1-v2-types.ts";

export const FINAL_BEFORE_REVISION = "c46aae1af1b78a6f81ea40c3099edde0ba35ebd5" as const;
export const FINAL_AFTER_REVISION = "394c98a97428b741f8ea54273a226cb062455ab0" as const;
export const FINAL_MODEL = "openai/gpt-5.6-sol" as const;
export const FINAL_REASONING = "medium" as const;
export const FINAL_AUTH_MODE = "managed" as const;
export const FINAL_EXECUTION = { provider: "openai", authMode: FINAL_AUTH_MODE, model: FINAL_MODEL,
  reasoning: FINAL_REASONING, executionMode: "ordinary_non_fast", serviceTier: "default",
  requestExecutionMode: "auto_by_omission" } as const;
export const FINAL_POLICY = { sequential: true, runtimeReorderAllowed: false,
  replacementRunsAllowed: "pre_provider_infrastructure_only", preProviderInfrastructureReplacementMax: 1,
  postProviderReplacementAllowed: false, cacheMismatch: "descriptive_only", usageUnavailable: "nullable" } as const;
export const FINAL_ACCEPTANCE = { providerSendByteReductionMinimum: 0.30,
  requestHypothesis: { kind: "frozen_baseline_range", before: 45, afterMinimum: 38, afterMaximum: 40 },
  elapsedReductionTarget: [0.18, 0.30], zeroQualityRegression: true } as const;

export type BenchmarkVersion = "before" | "after";
export type ProviderAuthMode = "oauth" | "api_key" | "managed";

export interface PairedSourcePin {
  version: BenchmarkVersion;
  revision: string;
  compatibilitySha256: string;
  platform: string;
  mode: "bundled_agent_release";
  preparedResource: PreparedButlerResourceIdentity;
}

export interface PairedStepIdentity {
  key: string;
  version: BenchmarkVersion;
  fixture: M1V2ArmId;
  repetition: number;
  block: number;
  order: number;
  pairId: string;
  fixtureSha256: string;
  source: PairedSourcePin;
}

export interface PairedExecutionContract {
  provider: "openai";
  authMode: typeof FINAL_AUTH_MODE;
  model: typeof FINAL_MODEL;
  reasoning: typeof FINAL_REASONING;
  executionMode: "ordinary_non_fast";
  serviceTier: "default";
  requestExecutionMode: "auto_by_omission";
}

export interface PairedCampaignContract {
  schema: "butler.agent-benchmark.paired-contract.v1";
  before: PairedSourcePin;
  after: PairedSourcePin;
  execution: PairedExecutionContract;
  authReceipt: ProviderAuthPreflight;
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>;
  provenance: M1V2ProvenanceIdentity;
  preparedPinsIdentity: string;
  steps: readonly PairedStepIdentity[];
  policy: {
    sequential: true;
    runtimeReorderAllowed: false;
    replacementRunsAllowed: "pre_provider_infrastructure_only";
    preProviderInfrastructureReplacementMax: 1;
    postProviderReplacementAllowed: false;
    cacheMismatch: "descriptive_only";
    usageUnavailable: "nullable";
  };
  acceptance: {
    providerSendByteReductionMinimum: 0.30;
    requestHypothesis: typeof FINAL_ACCEPTANCE.requestHypothesis;
    elapsedReductionTarget: readonly [0.18, 0.30];
    zeroQualityRegression: true;
  };
  identity: string;
}

export interface ProviderAuthPreflight {
  schema: "butler.provider-auth-preflight-receipt.v1";
  authority: "butler_auth_status_and_model_catalog";
  provider: "openai";
  authMode: typeof FINAL_AUTH_MODE;
  observedProductAuthMode: "codex_oauth" | "codex_subscription";
  observedProductAuthSource: "CODEX_AUTH_JSON" | "BUTLER_CODEX_AUTH_PROFILE";
  model: typeof FINAL_MODEL;
  reasoning: typeof FINAL_REASONING;
  executionMode: "ordinary_non_fast";
  modelCallability: "available" | "unavailable";
  configured: boolean;
}

export function validateProviderAuthPreflight(value: Partial<ProviderAuthPreflight>): ProviderAuthPreflight {
  if (Object.keys(value).sort().join("|") !== ["authMode", "authority", "configured", "executionMode", "model", "modelCallability", "observedProductAuthMode", "observedProductAuthSource", "provider", "reasoning", "schema"].sort().join("|"))
    throw new Error("Provider auth preflight contains non-allowlisted fields.");
  if (value.schema !== "butler.provider-auth-preflight-receipt.v1" ||
      value.authority !== "butler_auth_status_and_model_catalog" || value.provider !== "openai" ||
      value.authMode !== FINAL_AUTH_MODE || !validManagedAuthEvidence(value) ||
      value.model !== FINAL_MODEL || value.reasoning !== FINAL_REASONING ||
      value.executionMode !== "ordinary_non_fast" ||
      !["available", "unavailable"].includes(value.modelCallability ?? "") || typeof value.configured !== "boolean") {
    throw new Error("Provider auth preflight is invalid or not the canonical ordinary non-fast model contract.");
  }
  return value as ProviderAuthPreflight;
}

function validManagedAuthEvidence(value: Partial<ProviderAuthPreflight>): boolean {
  return (value.observedProductAuthMode === "codex_oauth" && value.observedProductAuthSource === "CODEX_AUTH_JSON") ||
    (value.observedProductAuthMode === "codex_subscription" && value.observedProductAuthSource === "BUTLER_CODEX_AUTH_PROFILE");
}

export function requireAvailableProviderAuth(value: ProviderAuthPreflight): PairedExecutionContract {
  validateProviderAuthPreflight(value);
  if (!value.configured || value.modelCallability !== "available") {
    throw new Error("measurement_unavailable: provider authentication or exact model is unavailable");
  }
  return FINAL_EXECUTION;
}

export function createPairedCampaignContract(input: {
  before: PairedSourcePin;
  after: PairedSourcePin;
  execution: PairedExecutionContract;
  authReceipt: ProviderAuthPreflight;
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>;
  provenance: M1V2ProvenanceIdentity;
}): PairedCampaignContract {
  validatePin(input.before, "before");
  validatePin(input.after, "after");
  if (input.before.revision === input.after.revision ||
      input.before.preparedResource.resourceSha256 === input.after.preparedResource.resourceSha256) {
    throw new Error("Paired source and prepared-resource pins must be distinct.");
  }
  const steps = canonicalSteps(input.before, input.after, input.fixtureHashes);
  const stable = {
    schema: "butler.agent-benchmark.paired-contract.v1" as const,
    before: input.before, after: input.after, execution: input.execution, authReceipt: input.authReceipt,
    fixtureHashes: input.fixtureHashes, provenance: input.provenance,
    preparedPinsIdentity: digest({ before: input.before.preparedResource, after: input.after.preparedResource }), steps,
    policy: FINAL_POLICY, acceptance: FINAL_ACCEPTANCE,
  };
  return { ...stable, identity: digest(stable) };
}

export function validatePairedCampaignContract(contract: PairedCampaignContract): void {
  validatePin(contract.before, "before");
  validatePin(contract.after, "after");
  const { identity, ...stable } = contract;
  const expected = canonicalSteps(contract.before, contract.after, contract.fixtureHashes);
  if (identity !== digest(stable) || contract.before.revision !== FINAL_BEFORE_REVISION ||
      contract.after.revision !== FINAL_AFTER_REVISION || JSON.stringify(contract.execution) !== JSON.stringify(FINAL_EXECUTION) ||
      contract.authReceipt.authMode !== contract.execution.authMode ||
      JSON.stringify(requireAvailableProviderAuth(contract.authReceipt)) !== JSON.stringify(FINAL_EXECUTION) ||
      JSON.stringify(contract.policy) !== JSON.stringify(FINAL_POLICY) || JSON.stringify(contract.acceptance) !== JSON.stringify(FINAL_ACCEPTANCE) ||
      contract.preparedPinsIdentity !== digest({ before: contract.before.preparedResource, after: contract.after.preparedResource }) ||
      JSON.stringify(contract.steps) !== JSON.stringify(expected) ||
      contract.steps.some((step) => JSON.stringify(step.source) !== JSON.stringify(step.version === "before" ? contract.before : contract.after)) ||
      !validProvenance(contract.provenance)) {
    throw new Error("Paired campaign contract identity mismatch.");
  }
}

function canonicalSteps(
  before: PairedSourcePin,
  after: PairedSourcePin,
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>,
): PairedStepIdentity[] {
  const fixtures: readonly M1V2ArmId[] = ["direct-cold", "direct-warm", "current-web-cold", "landing-cold"];
  const steps: PairedStepIdentity[] = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    for (const fixture of fixtures) {
      const block = steps.length / 2;
      const pairId = `${fixture}:rep-${repetition}`;
      for (const version of ["before", "after"] as const) {
        const source = version === "before" ? before : after;
        steps.push({
          key: `${pairId}:${version}`, version, fixture, repetition,
          block, order: steps.length, pairId,
          fixtureSha256: fixtureHashes[fixture], source,
        });
      }
    }
  }
  return steps;
}

export function corroborateExecution(input: {
  preregistered: PairedExecutionContract;
  observed: { provider: string; model: string; reasoning: string; serviceTier?: string | null; requestServiceTier?: string | null };
}): void {
  const observed = input.observed;
  if (observed.provider !== input.preregistered.provider ||
      observed.model !== input.preregistered.model ||
      observed.reasoning !== input.preregistered.reasoning ||
      (observed.serviceTier ?? observed.requestServiceTier) !== input.preregistered.serviceTier) {
    throw new Error("non_fast_model_execution_identity_mismatch");
  }
}

export function corroboratePairedRequestEvidence(preregistered: PairedExecutionContract, receipt: ProviderAuthPreflight, evidence: {
  provider: string; model: string; reasoning: string;
  providerServiceTiers: readonly (string | null)[]; requestServiceTiers: readonly (string | null)[];
  requestModels: readonly (string | null)[]; requestReasoning: readonly (string | null)[];
  authorizationSchemes: readonly (string | null)[];
} | undefined): void {
  if (!evidence || evidence.providerServiceTiers.length === 0 ||
      evidence.providerServiceTiers.some((value) => value !== preregistered.serviceTier) ||
      evidence.requestServiceTiers.some((value) => value !== "auto_by_omission") ||
      evidence.requestModels.some((value) => value !== preregistered.model) ||
      evidence.requestReasoning.some((value) => value !== preregistered.reasoning) ||
      evidence.authorizationSchemes.some((value) => value !== "bearer")) {
    throw new Error("provider_service_tier_unavailable_or_mismatch");
  }
  if (receipt.authMode !== preregistered.authMode || !receipt.configured || receipt.modelCallability !== "available")
    throw new Error("provider_auth_receipt_unavailable_or_mismatch");
  corroborateExecution({ preregistered, observed: { provider: evidence.provider, model: evidence.model,
    reasoning: evidence.reasoning, serviceTier: evidence.providerServiceTiers[0] } });
}

export function replacementEligibility(input: {
  providerDispatchState: "not_dispatched" | "adapter_entered" | "provider_dispatched" | "provider_output_observed";
  infrastructureGateStage: "pre_adapter" | null;
}): { allowed: boolean; reason: string } {
  return input.providerDispatchState === "not_dispatched" && input.infrastructureGateStage === "pre_adapter"
    ? { allowed: true, reason: "pre_provider_infrastructure_replacement" }
    : { allowed: false, reason: "post_adapter_replacement_forbidden" };
}

function validatePin(pin: PairedSourcePin, version: BenchmarkVersion): void {
  if (pin.version !== version || !/^[a-f0-9]{40}$/u.test(pin.revision) ||
      !/^[a-z0-9_-]+$/u.test(pin.platform) || pin.mode !== "bundled_agent_release" ||
      pin.preparedResource.sourceRevision !== pin.revision ||
      pin.preparedResource.sourceCompatibilitySha256 !== pin.compatibilitySha256 ||
      ![pin.compatibilitySha256, pin.preparedResource.manifestSha256, pin.preparedResource.dependencyClosureSha256,
        pin.preparedResource.resourceSha256, pin.preparedResource.archiveSha256].every((value) => /^[a-f0-9]{64}$/u.test(value)) ||
      !Number.isSafeInteger(pin.preparedResource.resourceBytes) || pin.preparedResource.resourceBytes <= 0 ||
      !Number.isSafeInteger(pin.preparedResource.archiveBytes) || pin.preparedResource.archiveBytes <= 0) {
    throw new Error(`${version} source/prepared-resource pin mismatch`);
  }
}

function validProvenance(value: M1V2ProvenanceIdentity): boolean {
  return value.schema === "butler.agent-benchmark.provenance-identity.v1" &&
    [value.metadataSha256, value.jsonlSha256, value.verifiedSha256].every((digest) => /^[a-f0-9]{64}$/u.test(digest));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
