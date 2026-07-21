import { modelStructuredDecisionTransport } from "../../../../integrations/providers/model-catalog.ts";
import { parseModelRef } from "../../../../integrations/providers/model-ref.ts";
import {
  runFunctionToolPromptText,
  runPromptTextWithUsage,
} from "../../../../integrations/providers/runtime.ts";
import type {
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
  assertSerializableControls(input);
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
      schema: input.responseSchema,
      strict: true,
    },
    cacheScope: input.cacheScope,
    signal: input.signal,
    providerRetryAttempts: 1,
  });
  const actual = parseModelRef(result.model);
  const exactIdentityObserved = actual.canonicalRef === modelRef;
  return {
    carrier: parseJsonCarrier(result.text),
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
  await runFunctionToolPromptText({
    prompt: input.prompt,
    instructions: input.instructions,
    model: modelRef,
    reasoningEffort: input.modelSelection.reasoningEffort,
    cacheScope: input.cacheScope,
    signal: input.signal,
    providerRetryAttempts: 1,
    tools: [{
      type: "function",
      name: "submit_btcc_provider_carrier",
      description: "Submit the one closed carrier for this BTCC phase round.",
      parameters: input.responseSchema,
    }],
    toolChoice: "required",
    maxToolRounds: 1,
    handoffAfterToolBatch: true,
    executeTool(call) {
      carrierCount += 1;
      if (carrierCount === 1) carrier = call.args;
      return Promise.resolve({ accepted: true });
    },
    finalTextFromToolResult() {
      return JSON.stringify({ accepted: true });
    },
  });
  if (carrierCount !== 1 || carrier === undefined) {
    throw new Error("provider_protocol_invalid_carrier_count");
  }
  return {
    carrier,
    actualIdentity: {
      provider: input.modelSelection.provider,
      model: input.modelSelection.model,
      reasoningEffort: input.modelSelection.reasoningEffort,
      controlsHash: input.modelSelection.controlsHash,
    },
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

function assertSerializableControls(input: ProviderPhasePrompt): void {
  const controls = input.modelSelection.controls;
  const keys = Object.keys(controls);
  if (keys.some((key) => key !== "reasoningEffort")) {
    throw new Error("provider_controls_not_serializable");
  }
  if (
    controls.reasoningEffort !== undefined &&
    controls.reasoningEffort !== input.modelSelection.reasoningEffort
  ) {
    throw new Error("provider_reasoning_control_mismatch");
  }
}

function parseJsonCarrier(text: string): unknown {
  return JSON.parse(text) as unknown;
}
