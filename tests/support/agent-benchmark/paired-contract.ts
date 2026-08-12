import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { M1V2ArmId } from "./m1-v2-types.ts";
import type { PreparedButlerResourceIdentity } from "./prepared-butler-resource.ts";

export const FINAL_BEFORE_REVISION = "c46aae1af1b78a6f81ea40c3099edde0ba35ebd5" as const;
export const FINAL_AFTER_REVISION = "394c98a97428b741f8ea54273a226cb062455ab0" as const;
export const FINAL_MODEL = "openai/gpt-5.6-sol" as const;
export const FINAL_REASONING = "medium" as const;

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
  authMode: ProviderAuthMode;
  model: typeof FINAL_MODEL;
  reasoning: typeof FINAL_REASONING;
  executionMode: "ordinary_non_fast";
  serviceTier: "default";
  requestOption: { service_tier: "default" };
}

export interface PairedCampaignContract {
  schema: "butler.agent-benchmark.paired-contract.v1";
  before: PairedSourcePin;
  after: PairedSourcePin;
  execution: PairedExecutionContract;
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
    elapsedReductionTarget: readonly [0.18, 0.30];
    zeroQualityRegression: true;
  };
  identity: string;
}

export interface ProviderAuthPreflight {
  provider: "openai";
  authMode: ProviderAuthMode;
  model: typeof FINAL_MODEL;
  reasoning: typeof FINAL_REASONING;
  executionMode: "ordinary_non_fast";
  modelAvailable: boolean;
  authenticated: boolean;
}

export function readProviderAuthPreflight(path: string): ProviderAuthPreflight {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderAuthPreflight>;
  if (value.provider !== "openai" || !["oauth", "api_key", "managed"].includes(value.authMode ?? "") ||
      value.model !== FINAL_MODEL || value.reasoning !== FINAL_REASONING ||
      value.executionMode !== "ordinary_non_fast" ||
      typeof value.modelAvailable !== "boolean" || typeof value.authenticated !== "boolean") {
    throw new Error("Provider auth preflight is invalid or not the canonical ordinary non-fast model contract.");
  }
  return value as ProviderAuthPreflight;
}

export function requireAvailableProviderAuth(value: ProviderAuthPreflight): PairedExecutionContract {
  if (!value.authenticated || !value.modelAvailable) {
    throw new Error("measurement_unavailable: provider authentication or exact model is unavailable");
  }
  return {
    provider: "openai", authMode: value.authMode, model: FINAL_MODEL,
    reasoning: FINAL_REASONING, executionMode: "ordinary_non_fast",
    serviceTier: "default", requestOption: { service_tier: "default" },
  };
}

export function createPairedCampaignContract(input: {
  before: PairedSourcePin;
  after: PairedSourcePin;
  execution: PairedExecutionContract;
  fixtureHashes: Readonly<Record<M1V2ArmId, string>>;
}): PairedCampaignContract {
  validatePin(input.before, "before");
  validatePin(input.after, "after");
  if (input.before.revision === input.after.revision ||
      input.before.preparedResource.resourceSha256 === input.after.preparedResource.resourceSha256) {
    throw new Error("Paired source and prepared-resource pins must be distinct.");
  }
  const fixtures: readonly M1V2ArmId[] = ["direct-cold", "direct-warm", "current-web-cold", "landing-cold"];
  const steps: PairedStepIdentity[] = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    for (const fixture of fixtures) {
      const block = steps.length / 2;
      const pairId = `${fixture}:rep-${repetition}`;
      for (const version of ["before", "after"] as const) {
        const source = version === "before" ? input.before : input.after;
        steps.push({
          key: `${pairId}:${version}`, version, fixture, repetition,
          block, order: steps.length, pairId,
          fixtureSha256: input.fixtureHashes[fixture], source,
        });
      }
    }
  }
  const stable = {
    schema: "butler.agent-benchmark.paired-contract.v1" as const,
    before: input.before, after: input.after, execution: input.execution, steps,
    policy: {
      sequential: true as const, runtimeReorderAllowed: false as const,
      replacementRunsAllowed: "pre_provider_infrastructure_only" as const,
      preProviderInfrastructureReplacementMax: 1 as const,
      postProviderReplacementAllowed: false as const,
      cacheMismatch: "descriptive_only" as const, usageUnavailable: "nullable" as const,
    },
    acceptance: {
      providerSendByteReductionMinimum: 0.30 as const,
      elapsedReductionTarget: [0.18, 0.30] as const,
      zeroQualityRegression: true as const,
    },
  };
  return { ...stable, identity: digest(stable) };
}

export function validatePairedCampaignContract(contract: PairedCampaignContract): void {
  const { identity, ...stable } = contract;
  if (identity !== digest(stable) || contract.before.revision !== FINAL_BEFORE_REVISION ||
      contract.after.revision !== FINAL_AFTER_REVISION || contract.steps.length !== 24 ||
      contract.steps.some((step, order) => step.order !== order || step.block !== Math.floor(order / 2) ||
        step.version !== (order % 2 === 0 ? "before" : "after"))) {
    throw new Error("Paired campaign contract identity mismatch.");
  }
}

export function corroborateExecution(input: {
  preregistered: PairedExecutionContract;
  observed: { provider: string; model: string; reasoning: string; serviceTier?: string | null; requestServiceTier?: string | null };
}): void {
  const observed = input.observed;
  if (observed.provider !== "openai" || observed.model !== FINAL_MODEL ||
      observed.reasoning !== FINAL_REASONING ||
      (observed.serviceTier ?? observed.requestServiceTier) !== "default") {
    throw new Error("non_fast_model_execution_identity_mismatch");
  }
}

export function replacementEligibility(input: {
  providerDispatchStarted: boolean;
  providerOutputObserved: boolean;
}): { allowed: boolean; reason: string } {
  return input.providerDispatchStarted || input.providerOutputObserved
    ? { allowed: false, reason: "post_dispatch_replacement_forbidden" }
    : { allowed: true, reason: "pre_provider_infrastructure_replacement" };
}

function validatePin(pin: PairedSourcePin, version: BenchmarkVersion): void {
  if (pin.version !== version || !/^[a-f0-9]{40}$/u.test(pin.revision) ||
      !/^[a-z0-9_-]+$/u.test(pin.platform) || pin.mode !== "bundled_agent_release" ||
      pin.preparedResource.sourceRevision !== pin.revision ||
      pin.preparedResource.sourceCompatibilitySha256 !== pin.compatibilitySha256) {
    throw new Error(`${version} source/prepared-resource pin mismatch`);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
