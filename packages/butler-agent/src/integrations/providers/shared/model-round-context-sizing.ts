import type { ModelRoundPort } from "../../../agent/btcc/ports/model-round.ts";
import { estimateTokensForModel, findModelMetadata } from "../model-catalog.ts";
import { openAIBoundedConversationItems } from "../openai/conversation-items.ts";
import { readLocalModelConfigs } from "../local/models.ts";
import { registeredHostedModelMetadata } from "./registered-models.ts";

/** Uses the same model tokenizer/catalog as final provider request admission.
 * Sizes are expressed in conservative byte-equivalent units for BTCC's existing
 * context envelope. Images consume tokens, not the base64 text byte count.
 */
export const modelRoundContextSizing: NonNullable<ModelRoundPort["contextSizing"]> = (request) => {
  const model = String(request.model);
  const metadata = model.startsWith("local/")
    ? readLocalModelConfigs(request.butlerData).find((entry) => entry.model_ref === model)
    : (request.butlerData ? registeredHostedModelMetadata(request.butlerData).find((entry) => entry.model_ref === model) : undefined) ?? findModelMetadata(model);
  if (!metadata?.context_window_tokens) return undefined;
  const output = request.maxOutputTokens ?? metadata.max_output_tokens ?? 0;
  const imageCount = request.attachments?.filter((a) => a.kind === "image").length ?? 0;
  const fixed = estimateTokensForModel(JSON.stringify({ instructions: request.instructions,
    tools: request.tools, tool_choice: "auto", model }), model).tokens + imageCount * 8192;
  return {
    maxOutputTokens: metadata.max_output_tokens,
    maxMessageBytes: Math.max(1, (metadata.context_window_tokens - output - fixed) * 2),
    messageBytes: (messages) => {
      const serialized = model.startsWith("openai/")
        ? openAIBoundedConversationItems(messages).items
        : messages.map(({ providerData: _provider, continuationItemId: _id, operationResultReference: _reference,
            operationResultCallId: _callId, requestSegmentKind: _kind, ...message }) => message);
      return estimateTokensForModel(JSON.stringify(serialized), model).tokens * 2;
    },
  };
};
