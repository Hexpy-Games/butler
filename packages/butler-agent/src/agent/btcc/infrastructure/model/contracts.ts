import type {
  ActualModelIdentity,
  ModelPhaseState,
  OperationAuthority,
  OperationRequest,
} from "../../core/index.ts";
import type { AdmittedModelSelection } from "../../contracts.ts";
import type { PhaseGuidanceReader } from "../../guidance/index.ts";
import type { PromptCacheBoundary } from "../../../../integrations/providers/contracts.ts";

export type ResolvedContextDocument = {
  ref: string;
  content: string;
};

export interface ButlerContextResolver {
  resolve(ref: string): Promise<string> | string;
}

export type StructuralCapabilityDefinition = {
  capabilityRef: string;
  name: string;
  description: string;
  operationKinds: readonly OperationRequest["kind"][];
  inputSchema: Record<string, unknown>;
  observationScopeRefs?: readonly string[];
  observationScopeKinds?: readonly ObservationScopeKind[];
};

export type ObservationScopeKind =
  | "workspace"
  | "web"
  | "memory"
  | "ledger"
  | "result";

export interface StructuralCapabilityCatalog {
  list(): Promise<readonly StructuralCapabilityDefinition[]> |
    readonly StructuralCapabilityDefinition[];
}

export type AvailablePhaseCapability = Omit<
  StructuralCapabilityDefinition,
  "operationKinds" | "observationScopeKinds"
> & {
  operationKind: OperationRequest["kind"];
  observationScopeRefs: readonly string[];
};

export type ProviderCapabilityVocabularyEntry = Omit<
  StructuralCapabilityDefinition,
  "operationKinds" | "observationScopeKinds" | "observationScopeRefs"
> & {
  operationKind: OperationRequest["kind"];
};

export type ProviderPhasePrompt = {
  modelSelection: AdmittedModelSelection;
  instructions: string;
  prompt: string;
  promptCacheBoundary: PromptCacheBoundary;
  responseSchema: Record<string, unknown>;
  carrierFunctions: readonly ProviderCarrierFunction[];
  cacheScope: string;
  usageAttribution: {
    turnId: string;
    phase: ModelPhaseState;
  };
  signal?: AbortSignal;
};

export type ProviderCarrierFunction = {
  name: string;
  description: string;
  carrierKind: "phase_submission" | "operation_requests";
  parameters: Record<string, unknown>;
};

export type ProviderPhasePromptResult = {
  carrier: unknown;
  actualIdentity: ActualModelIdentity;
};

export interface ProviderPhasePromptRunner {
  run(input: ProviderPhasePrompt): Promise<ProviderPhasePromptResult>;
}

export type ProductionSelectedModelDependencies = {
  context: ButlerContextResolver;
  capabilities: StructuralCapabilityCatalog;
  guidance: PhaseGuidanceReader;
  promptRunner?: ProviderPhasePromptRunner;
  roundBoundary?: {
    totalTimeoutMs?: number;
  };
};

export type RenderedPhasePrompt = {
  instructions: string;
  prompt: string;
  promptCacheBoundary: PromptCacheBoundary;
  responseSchema: Record<string, unknown>;
  carrierFunctions: readonly ProviderCarrierFunction[];
};

export type ResolvePhaseCapabilitiesInput = {
  authority: OperationAuthority;
  catalog: StructuralCapabilityCatalog;
};
