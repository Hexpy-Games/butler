import type { ModelRef } from "../../gateways/core/contracts.ts";
import type {
  ModelProviderAdapter,
  ProviderCapabilities,
} from "./contracts.ts";
import { parseModelRef } from "./model-ref.ts";
import { DEFAULT_MODEL_REF, type ModelProviderId } from "./model-catalog.ts";
import { ANTHROPIC_PROVIDER_ADAPTER } from "./anthropic/adapter.ts";
import { GOOGLE_PROVIDER_ADAPTER } from "./google/adapter.ts";
import { KIMI_PROVIDER_ADAPTER } from "./kimi/adapter.ts";
import { LOCAL_PROVIDER_ADAPTER } from "./local/adapter.ts";
import { OPENAI_PROVIDER_ADAPTER } from "./openai/adapter.ts";
import { OPENCODE_GO_PROVIDER_ADAPTER } from "./opencode-go/adapter.ts";
import { QWEN_PROVIDER_ADAPTER } from "./qwen/adapter.ts";
import type { ProviderAdapterDefinition } from "./shared/adapter-definition.ts";
import { XAI_PROVIDER_ADAPTER } from "./xai/adapter.ts";
import { ZAI_PROVIDER_ADAPTER } from "./zai/adapter.ts";

const PROVIDER_ADAPTERS: ReadonlyMap<ModelProviderId, ProviderAdapterDefinition> = new Map([
  ["openai", OPENAI_PROVIDER_ADAPTER],
  ["anthropic", ANTHROPIC_PROVIDER_ADAPTER],
  ["google", GOOGLE_PROVIDER_ADAPTER],
  ["xai", XAI_PROVIDER_ADAPTER],
  ["qwen", QWEN_PROVIDER_ADAPTER],
  ["kimi", KIMI_PROVIDER_ADAPTER],
  ["zai", ZAI_PROVIDER_ADAPTER],
  ["opencode-go", OPENCODE_GO_PROVIDER_ADAPTER],
  ["local", LOCAL_PROVIDER_ADAPTER],
]);

export function getRegisteredProviderAdapterDefinitions(): readonly ProviderAdapterDefinition[] {
  return [...PROVIDER_ADAPTERS.values()];
}

export function resolveProviderAdapterDefinition(modelRef: string): ProviderAdapterDefinition {
  const parsed = parseModelRef(modelRef.trim() || DEFAULT_MODEL_REF);
  const adapter = PROVIDER_ADAPTERS.get(parsed.providerId as ModelProviderId);
  if (!adapter) throw new Error(`provider_adapter_not_registered:${parsed.providerId}`);
  return adapter;
}

export function providerCapabilitiesForModel(modelRef: string): ProviderCapabilities {
  const effectiveModelRef = modelRef.trim() || DEFAULT_MODEL_REF;
  return resolveProviderAdapterDefinition(effectiveModelRef).capabilitiesFor(effectiveModelRef);
}

export function bindProviderToModel(
  provider: ModelProviderAdapter,
  model: ModelRef,
): ModelProviderAdapter {
  if (provider.forModel) return provider.forModel(model);
  if (!provider.capabilitiesFor) return provider;
  const capabilities = provider.capabilitiesFor(model);
  return {
    id: parseModelRef(model.trim() || DEFAULT_MODEL_REF).providerId,
    capabilities,
    capabilitiesFor: provider.capabilitiesFor.bind(provider),
    forModel(nextModel) {
      return bindProviderToModel(provider, nextModel);
    },
    async invoke(input) {
      return await provider.invoke(input);
    },
    ...(provider.stream
      ? { stream: (input: Parameters<NonNullable<ModelProviderAdapter["stream"]>>[0]) => provider.stream!(input) }
      : {}),
  };
}
