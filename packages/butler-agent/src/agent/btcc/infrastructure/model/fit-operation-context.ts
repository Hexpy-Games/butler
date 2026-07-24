import {
  estimateTokensForModel,
  resolveModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import type { AdmittedModelSelection } from "../../contracts.ts";
import {
  operationContextCompactionCandidates,
  type ProjectedOperationContext,
} from "./project-operation-context.ts";

export function fitOperationContext(input: {
  projected: ProjectedOperationContext;
  modelSelection: AdmittedModelSelection;
  renderPrompt: (context: ProjectedOperationContext) => string;
  fixedRequestShape: unknown;
}): ProjectedOperationContext {
  const modelRef = canonicalModelRef(input.modelSelection);
  const metadata = resolveModelMetadata(modelRef);
  const contextWindow = Math.min(
    input.modelSelection.contextWindowTokens ?? metadata.context_window_tokens,
    metadata.context_window_tokens,
  );
  const inputCapacity = contextWindow - metadata.max_output_tokens;

  const candidates = operationContextCompactionCandidates(input.projected);
  let finalEstimate = 0;
  for (const candidate of candidates) {
    const serialized = JSON.stringify({
      ...asRecord(input.fixedRequestShape),
      prompt: input.renderPrompt(candidate),
    });
    finalEstimate = estimateTokensForModel(serialized, modelRef).tokens;
    if (finalEstimate <= inputCapacity) {
      return candidate;
    }
  }
  throw new PhasePromptCapacityError({
    modelRef,
    estimatedInputTokens: finalEstimate,
    inputCapacityTokens: inputCapacity,
  });
}

export class PhasePromptCapacityError extends Error {
  override readonly name = "PhasePromptCapacityError";

  constructor(readonly receipt: {
    modelRef: string;
    estimatedInputTokens: number;
    inputCapacityTokens: number;
  }) {
    super(
      `BTCC phase prompt needs ${receipt.estimatedInputTokens} input tokens; ` +
      `${receipt.modelRef} admits ${receipt.inputCapacityTokens}`,
    );
  }
}

function canonicalModelRef(selection: AdmittedModelSelection): string {
  return selection.model.includes("/")
    ? selection.model
    : `${selection.provider}/${selection.model}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}
