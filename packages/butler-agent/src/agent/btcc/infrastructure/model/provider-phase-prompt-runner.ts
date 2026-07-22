import { modelStructuredDecisionTransport } from "../../../../integrations/providers/model-catalog.ts";
import { parseModelRef } from "../../../../integrations/providers/model-ref.ts";
import {
  runFunctionToolPromptText,
  runPromptTextWithUsage,
} from "../../../../integrations/providers/runtime.ts";
import type {
  ProviderCarrierFunction,
  ProviderPhasePrompt,
  ProviderPhasePromptResult,
  ProviderPhasePromptRunner,
} from "./contracts.ts";

export function createProviderPhasePromptRunner(): ProviderPhasePromptRunner {
  return { run: runProviderPhasePrompt };
}

async function runProviderPhasePrompt(
  input: ProviderPhasePrompt,
): Promise<ProviderPhasePromptResult> {
  const modelRef = exactModelRef(input);
  const transport = modelStructuredDecisionTransport(modelRef);
  if (transport === "json_schema") return runJsonSchemaRound(input, modelRef);
  if (transport === "function_tool") return runFunctionToolRound(input, modelRef);
  throw new Error(`provider_structured_transport_unavailable:${modelRef}`);
}

async function runJsonSchemaRound(
  input: ProviderPhasePrompt,
  modelRef: string,
): Promise<ProviderPhasePromptResult> {
  const result = await runPromptTextWithUsage({
    prompt: input.prompt,
    instructions: input.instructions,
    model: modelRef,
    reasoningEffort: input.modelSelection.reasoningEffort,
    responseFormat: {
      type: "json_schema",
      name: "btcc_provider_carrier",
      schema: jsonSchemaTransportSchema(input.responseSchema),
      strict: true,
    },
    cacheScope: input.cacheScope,
    signal: input.signal,
    providerRetryAttempts: 1,
  });
  const actual = parseModelRef(result.model);
  const exactIdentityObserved = actual.canonicalRef === modelRef;
  return {
    carrier: unwrapJsonSchemaCarrier(parseJsonCarrier(result.text)),
    actualIdentity: {
      provider: exactIdentityObserved ? input.modelSelection.provider : actual.providerId,
      model: exactIdentityObserved ? input.modelSelection.model : actual.modelId,
      reasoningEffort: input.modelSelection.reasoningEffort,
      controlsHash: input.modelSelection.controlsHash,
    },
  };
}

async function runFunctionToolRound(
  input: ProviderPhasePrompt,
  modelRef: string,
): Promise<ProviderPhasePromptResult> {
  let carrier: unknown;
  let carrierCount = 0;
  let observedModel = "";
  const functions = new Map(input.carrierFunctions.map((entry) => [entry.name, entry]));
  await runFunctionToolPromptText({
    prompt: input.prompt,
    instructions: `${input.instructions} Call exactly one supplied BTCC carrier function.`,
    model: modelRef,
    reasoningEffort: input.modelSelection.reasoningEffort,
    cacheScope: input.cacheScope,
    signal: input.signal,
    providerRetryAttempts: 1,
    tools: input.carrierFunctions.map(asFunctionTool),
    toolChoice: "required",
    maxToolRounds: 1,
    handoffAfterToolBatch: true,
    onProviderResponseIdentity(identity) {
      if (identity.provider !== input.modelSelection.provider) {
        throw new Error("provider_response_provider_mismatch");
      }
      const reported = parseModelRef(
        identity.reportedModel.includes("/")
          ? identity.reportedModel
          : `${identity.provider}/${identity.reportedModel}`,
      ).canonicalRef;
      if (observedModel && observedModel !== reported) {
        throw new Error("provider_response_model_changed_within_round");
      }
      observedModel = reported;
    },
    executeTool(call) {
      carrierCount += 1;
      const definition = functions.get(call.name);
      if (carrierCount === 1 && definition) {
        carrier = { kind: definition.carrierKind, ...call.args };
      }
      return Promise.resolve({ accepted: true });
    },
    finalTextFromToolResult() {
      return JSON.stringify({ accepted: true });
    },
  });
  if (carrierCount !== 1 || carrier === undefined) {
    throw new Error("provider_protocol_invalid_carrier_count");
  }
  if (!observedModel) throw new Error("provider_response_model_unobserved");
  const observed = parseModelRef(observedModel);
  return {
    carrier,
    actualIdentity: {
      provider: observed.providerId,
      model: observed.modelId,
      reasoningEffort: input.modelSelection.reasoningEffort,
      controlsHash: input.modelSelection.controlsHash,
    },
  };
}

function asFunctionTool(definition: ProviderCarrierFunction) {
  return {
    type: "function" as const,
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  };
}

function exactModelRef(input: ProviderPhasePrompt): string {
  const selected = input.modelSelection;
  const parsed = parseModelRef(
    selected.model.includes("/") ? selected.model : `${selected.provider}/${selected.model}`,
  );
  if (parsed.providerId !== selected.provider) {
    throw new Error("provider_model_selection_mismatch");
  }
  return parsed.canonicalRef;
}

function parseJsonCarrier(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function jsonSchemaTransportSchema(carrierSchema: Record<string, unknown>) {
  return {
    type: "object",
    properties: { carrier: carrierSchema },
    required: ["carrier"],
    additionalProperties: false,
  };
}

function unwrapJsonSchemaCarrier(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).carrier
    : undefined;
}
