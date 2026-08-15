import type {
  ModelRoundMessage,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import { agentLoopImageDataUrl } from "../../../agent/tools/tool-result-media.ts";
import {
  afterAttributedModelResponse,
  beforeAttributedModelRequest,
  extractResponseText,
  getFunctionCalls,
  modelFacingFunctionTools,
  openAIInputWithAttachments,
  parseToolArguments,
} from "../shared/runtime-support.ts";
import { serializeOpenAIVisualInput } from "../../../agent/image-attachment/index.ts";
import {
  buildReasoningConfig,
  resolveOpenAIModel,
  resolveOpenAIPromptCacheConfig,
} from "./config.ts";
import {
  createOpenAIResponse,
  functionCallContinuationItems,
  toCodexStatelessInput,
} from "./responses.ts";
import { logPromptCacheStats, recordPromptCacheMetric } from "./usage.ts";
import { resolveDynamicOpenAIModel } from "./models.ts";
import type { OpenAIAuthOverride } from "../runtime-contracts.ts";
import {
  extractPromptCacheStats,
  usageReportFromStats,
} from "../shared/runtime-support.ts";

interface OpenAIContinuation {
  provider: "openai";
  responseId: string;
  sent: {
    toolMessages: number;
    userMessages: number;
  };
  statelessInput: Array<Record<string, unknown>>;
}

export async function runOpenAIModelRound(
  request: ModelRoundRequest,
  authOverride?: OpenAIAuthOverride,
  modelOverride?: string,
): Promise<ModelRoundResult> {
  const resolution = resolveOpenAIModel(
    modelOverride ?? request.model,
    request.reasoningEffort,
  );
  const model = await resolveDynamicOpenAIModel(resolution.model);
  const reasoning = buildReasoningConfig(resolution);
  const promptCache = resolveOpenAIPromptCacheConfig(
    request.cacheScope ?? "btcc-agent-loop",
  );
  const previous = isOpenAIContinuation(request.continuation)
    ? request.continuation
    : null;
  const firstUser = request.messages.find((message) => message.role === "user");
  const imageManifests = request.imageManifests ?? request.attachments
    ?.flatMap((attachment) => attachment.visualManifest ? [attachment.visualManifest] : []) ?? [];
  const initialInput = imageManifests.length > 0
    ? await serializeOpenAIVisualInput({
        text: firstUser?.content ?? "",
        manifests: imageManifests,
        payloadPort: request.verifiedImagePayloadPort ?? {
          read: async () => {
            throw new Error("verified_image_payload_port_missing");
          },
        },
      })
    : openAIInputWithAttachments(
        firstUser?.content ?? "",
        request.attachments ? [...request.attachments] : undefined,
      );
  const initialStatelessInput = toCodexStatelessInput(initialInput);
  const continuationMessages = previous
    ? newOpenAIContinuationMessages(
        request.messages,
        previous.sent,
        request.butlerData,
      )
    : null;
  const requestItems = continuationMessages?.items ?? initialInput;
  const statelessRequestInput = previous
    ? [...previous.statelessInput, ...continuationMessages!.statelessItems]
    : initialStatelessInput;
  const roundIndex = request.usageAttribution?.roundIndex ?? 0;
  beforeAttributedModelRequest({
    attribution: request.usageAttribution,
    roundIndex,
  });

  const response = await createOpenAIResponse(
    {
      model,
      store: true,
      ...promptCache,
      instructions: request.instructions,
      ...(request.tools.length > 0
        ? {
            tools: modelFacingFunctionTools(request.tools),
          }
        : {}),
      tool_choice: request.toolChoice ?? "auto",
      reasoning,
      ...(previous
        ? {
            previous_response_id: previous.responseId,
            input: requestItems,
            __butler_codex_stateless_input: statelessRequestInput,
          }
        : {
            input: requestItems,
            __butler_codex_stateless_input: initialStatelessInput,
          }),
    },
    request.signal,
    authOverride,
    request.onProviderStreamEvent,
    {
      attribution: request.usageAttribution,
      roundIndex,
    },
    undefined,
    request.providerRetryAttempts,
  );

  recordPromptCacheMetric(response, {
    model,
    scope: request.cacheScope ?? "btcc-agent-loop",
    promptCache,
    butlerData: request.butlerData,
    usageAttribution: {
      ...request.usageAttribution,
      reasoningEffort: resolution.reasoningEffort,
      roundIndex,
    },
  });

  const responseStats = extractPromptCacheStats(response);
  const responseUsage = responseStats
    ? usageReportFromStats({ model, stats: responseStats, roundIndex })
    : null;
  afterAttributedModelResponse({
    attribution: request.usageAttribution,
    model,
    response,
    roundIndex,
  });
  const calls = getFunctionCalls(response).map((call) => ({
    id: call.call_id,
    name: call.name,
    arguments: parseToolArguments(call.arguments),
    rawArguments: call.arguments,
  }));
  const text = extractResponseText(response);
  const responseRecord = response as unknown as Record<string, unknown>;
  const reportedModel =
    typeof responseRecord.model === "string"
      ? String(responseRecord.model).trim()
      : "";
  const providerIdentity = reportedModel
    ? { provider: "openai", configuredModel: request.model, reportedModel }
    : undefined;
  if (providerIdentity) request.onProviderResponseIdentity?.(providerIdentity);

  const functionCalls = functionCallContinuationItems(response);
  const statelessInput = [...statelessRequestInput, ...functionCalls].map(
    retainTextOnlyAfterSuccessfulImageReplay,
  );
  const nextContinuation: OpenAIContinuation = {
    provider: "openai",
    responseId: response.id,
    sent: continuationMessages?.sent ?? { toolMessages: 0, userMessages: 1 },
    statelessInput,
  };
  if (continuationMessages) {
    nextContinuation.sent = continuationMessages.sent;
  }
  logPromptCacheStats(response, () => {}, promptCache);

  return {
    ...(text ? { text } : {}),
    toolCalls: calls,
    assistantMessage: {
      role: "assistant",
      content: text,
      toolCalls: calls,
      providerData: response.output,
    },
    continuation: nextContinuation,
    usage: responseUsage,
    ...(providerIdentity ? { providerIdentity } : {}),
    raw: response,
  };
}

function isOpenAIContinuation(value: unknown): value is OpenAIContinuation {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).provider === "openai" &&
    typeof (value as Record<string, unknown>).responseId === "string",
  );
}

function newOpenAIContinuationMessages(
  messages: readonly ModelRoundMessage[],
  alreadySent: OpenAIContinuation["sent"],
  butlerData?: string,
): {
  items: Array<Record<string, unknown>>;
  statelessItems: Array<Record<string, unknown>>;
  sent: OpenAIContinuation["sent"];
} {
  const items: Array<Record<string, unknown>> = [];
  const statelessItems: Array<Record<string, unknown>> = [];
  let toolMessages = 0;
  let userMessages = 0;
  for (const message of messages) {
    if (message.role === "tool") {
      toolMessages += 1;
      if (toolMessages <= alreadySent.toolMessages) continue;
      const [item, statelessItem] = openAIToolMessageItems(message, butlerData);
      items.push(item);
      statelessItems.push(statelessItem);
      continue;
    }
    if (message.role !== "user") continue;
    userMessages += 1;
    if (userMessages <= alreadySent.userMessages) continue;
    const item = {
      role: "user",
      content: [{ type: "input_text", text: message.content }],
    };
    items.push(item);
    statelessItems.push(item);
  }
  return { items, statelessItems, sent: { toolMessages, userMessages } };
}

function openAIToolMessageItems(
  message: ModelRoundMessage,
  butlerData?: string,
): [Record<string, unknown>, Record<string, unknown>] {
  const images = (message.imageAttachments ?? []).flatMap((attachment) => {
    const imageUrl = agentLoopImageDataUrl(attachment, butlerData);
    return imageUrl
      ? [{ type: "input_image", image_url: imageUrl, detail: "high" }]
      : [];
  });
  const output =
    images.length > 0
      ? [{ type: "input_text", text: message.content }, ...images]
      : message.content;
  const statelessItem = {
    type: "function_call_output",
    call_id: message.toolCallId,
    output,
  };
  return [
    {
      ...statelessItem,
      output,
    },
    statelessItem,
  ];
}

function retainTextOnlyAfterSuccessfulImageReplay(
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (item.type !== "function_call_output" || !Array.isArray(item.output))
    return item;
  const output = item.output.filter(
    (part) =>
      !(
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "input_image"
      ),
  );
  return output.length === item.output.length ? item : { ...item, output };
}
