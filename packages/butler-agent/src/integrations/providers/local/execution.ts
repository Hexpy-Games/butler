import type { PromptOptions } from "../runtime-contracts.ts";
import {
  createProviderRequestAttributor,
  localUserContentWithAttachments,
  openAICompatibleUsageSample,
  type ProviderRequestAttributor,
} from "../shared/runtime-support.ts";
import { createLocalChatCompletion, firstLocalAssistantMessage } from "./client.ts";
import {
  extractLocalChatText,
  type LocalChatMessage,
  localChatUrl,
  localReasoningRequestParams,
} from "./protocol.ts";
import { providerEmptyResponseError, safeEndpointLabel } from "../provider-errors.ts";
import { resolveLocalModelConfig } from "../shared/model-routing.ts";
import type { LocalModelConfig } from "./models.ts";

export async function runLocalPromptText(options: PromptOptions): Promise<string> {
  const config = resolveLocalModelConfig(options.model);
  return await runLocalPromptTextWithConfig(
    config,
    options,
    createProviderRequestAttributor({
      attribution: options.usageAttribution,
      butlerData: options.butlerData,
      cacheScope: options.cacheScope,
    }),
  );
}

export async function runLocalPromptTextWithConfig(
  config: LocalModelConfig,
  options: PromptOptions,
  requests = createProviderRequestAttributor({
    attribution: options.usageAttribution,
    butlerData: options.butlerData,
    cacheScope: options.cacheScope,
  }),
): Promise<string> {
  const messages: LocalChatMessage[] = [];
  if (options.instructions?.trim()) {
    messages.push({ role: "system", content: options.instructions.trim() });
  }
  messages.push({
    role: "user",
    content: localUserContentWithAttachments(options.prompt, options.attachments),
  });
  const response = await attributedLocalCompletion(config, options, requests, {
    model: config.model_id,
    messages,
    ...localReasoningRequestParams(config),
    stream: false,
  });
  const text = extractLocalChatText(firstLocalAssistantMessage(response));
  if (!text) {
    throw providerEmptyResponseError({
      provider: "local",
      api: "chat_completions",
      endpoint: safeEndpointLabel(localChatUrl(config)),
      model: config.model_id,
      local: true,
    });
  }
  return text;
}

function attributedLocalCompletion(
  config: LocalModelConfig,
  options: PromptOptions,
  requests: ProviderRequestAttributor,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  return requests.request({
    model: config.model_ref,
    run: async (context) => await createLocalChatCompletion(
      config,
      body,
      options.signal,
      context,
      undefined,
      options.providerRetryAttempts,
    ),
    usage: openAICompatibleUsageSample,
  });
}
