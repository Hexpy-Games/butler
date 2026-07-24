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

  for (const candidate of operationContextCompactionCandidates(input.projected)) {
    const serialized = JSON.stringify({
      ...asRecord(input.fixedRequestShape),
      prompt: input.renderPrompt(candidate),
    });
    if (estimateTokensForModel(serialized, modelRef).tokens <= inputCapacity) {
      return candidate;
    }
  }
  return operationContextCompactionCandidates(input.projected).at(-1)!;
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
