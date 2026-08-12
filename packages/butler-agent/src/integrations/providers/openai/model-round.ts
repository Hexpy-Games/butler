import type {
  ModelRoundMessage,
  ModelRoundRequest,
  ModelRoundResult,
} from "../../../agent/btcc/ports/model-round.ts";
import {
  afterAttributedModelResponse,
  beforeAttributedModelRequest,
  extractResponseText,
  getFunctionCalls,
  modelFacingFunctionTools,
  openAIInputWithAttachments,
  parseToolArguments,
} from "../shared/runtime-support.ts";
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
import type { M1RequestSegmentKind } from
  "../../../agent/btcc/ports/provider-request-attribution.ts";
import {
  appendOpenAIFunctionCallContinuityManifest,
  buildOpenAIRequestSegmentManifests,
  isOpenAIRequestSegmentContinuation,
  requiredLegacyOpenAISent,
  type OpenAIRequestSegmentContinuation,
} from "./request-segment-manifest.ts";
import {
  extractPromptCacheStats,
  usageReportFromStats,
} from "../shared/runtime-support.ts";
import {
  openAIBoundedConversationItems,
  openAIToolMessageItems,
  selectNewBoundedConversationItems,
} from "./conversation-items.ts";
import {
  parseDeliveredThroughOrdinal,
  turnItemOrdinal,
  validateBoundedProviderOrdinals,
} from "../../../agent/btcc/ports/bounded-provider-continuation.ts";
import {
  stableProviderOrderedBody,
} from "./stable-provider-prefix.ts";
import {
  stableProviderPrefixInvariant,
  type ProviderRouteCacheIdentity,
} from
  "../../../agent/btcc/ports/model-round.ts";

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
  const previous = isOpenAIRequestSegmentContinuation(request.continuation)
    ? request.continuation
    : null;
  if (request.stableProviderCachePrefix) {
    if (!request.routeContext) {
      throw stableProviderPrefixInvariant("stable_provider_prefix_route_context_missing");
    }
    if (request.routeContext.modelRef !== request.model) {
      throw stableProviderPrefixInvariant("stable_provider_prefix_route_model_mismatch");
    }
    if (previous && !previous.providerRouteIdentity) {
      throw stableProviderPrefixInvariant("stable_provider_prefix_previous_identity_missing");
    }
  }
  const firstUser = request.messages.find((message) => message.role === "user");
  const initialInput = openAIInputWithAttachments(
    firstUser?.content ?? "",
    request.attachments ? [...request.attachments] : undefined,
    Boolean(request.boundedContinuation),
  );
  const initialStatelessInput = toCodexStatelessInput(initialInput);
  const continuationMessages = previous && !request.boundedContinuation
      ? newOpenAIContinuationMessages(
        request.messages,
        requiredLegacyOpenAISent(previous.sent),
        request.butlerData,
      )
    : null;
  const projectedPreviousStatelessInput = previous && !request.boundedContinuation
    ? projectAcknowledgedToolOutputs(
        requiredLegacyStatelessInput(previous.statelessInput),
        request.messages,
      )
    : undefined;
  const boundedStatelessInput = request.boundedContinuation
    ? openAIBoundedConversationItems(
        request.messages,
        request.butlerData,
        initialStatelessInput,
      )
    : null;
  if (boundedStatelessInput && previous && previous.deliveredThroughOrdinal === undefined) {
    throw new Error("bounded_continuation_watermark_missing");
  }
  const deliveredThroughOrdinal = boundedStatelessInput && previous
    ? parseDeliveredThroughOrdinal(previous.deliveredThroughOrdinal)
    : -1;
  const boundedOfficialInput = boundedStatelessInput
    ? selectNewBoundedConversationItems(
        boundedStatelessInput,
        deliveredThroughOrdinal,
      )
    : null;
  const responseOrdinal = request.boundedContinuation
    ? turnItemOrdinal(request.boundedContinuation.responseItemId)
    : -1;
  if (boundedStatelessInput) validateBoundedProviderOrdinals(
    boundedStatelessInput.itemOrdinals,
    responseOrdinal,
    deliveredThroughOrdinal,
  );
  const requestItems = boundedOfficialInput?.items ??
    continuationMessages?.items ?? initialInput;
  const statelessRequestInput = boundedStatelessInput?.items ?? (previous
    ? [...projectedPreviousStatelessInput!, ...continuationMessages!.statelessItems]
    : initialStatelessInput);
  const roundIndex = request.usageAttribution?.roundIndex ?? 0;
  const segmentManifests = buildOpenAIRequestSegmentManifests({
    instructions: request.instructions,
    instructionSources: request.requestSegmentSources?.instructions,
    officialInput: requestItems,
    codexAppendedInput: boundedStatelessInput?.items ?? (previous
      ? continuationMessages!.statelessItems
      : initialStatelessInput),
    appendedItemKinds: boundedOfficialInput?.itemKinds ?? continuationMessages?.itemKinds,
    codexAppendedItemKinds: boundedStatelessInput?.itemKinds,
    promptSources: previous && !request.boundedContinuation
      ? []
      : request.requestSegmentSources?.input,
    previousCodexInput: request.boundedContinuation
      ? undefined
      : projectedPreviousStatelessInput,
    previousCodexManifest: request.boundedContinuation
      ? undefined
      : previous?.statelessManifest ?? [],
  });
  beforeAttributedModelRequest({
    attribution: request.usageAttribution,
    roundIndex,
  });

  const modelTools = request.tools.length > 0
    ? modelFacingFunctionTools(request.tools)
    : undefined;
  const dynamicBody = {
      model,
      store: true,
      ...promptCache,
      instructions: request.instructions,
      ...(modelTools ? { tools: modelTools } : {}),
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
            __butler_codex_stateless_input: statelessRequestInput,
          }),
    };
  const providerBody = request.stableProviderCachePrefix
    ? stableProviderOrderedBody({
        stable: request.stableProviderCachePrefix,
        model,
        tools: modelTools,
        toolChoice: request.toolChoice ?? "auto",
        reasoning,
        instructions: request.instructions,
        dynamic: Object.fromEntries(Object.entries(dynamicBody).filter(([key]) =>
          !["model", "tools", "tool_choice", "reasoning", "instructions"].includes(key),
        )),
      })
    : dynamicBody;
  let providerCacheIdentity: ProviderRouteCacheIdentity | undefined;
  const response = await createOpenAIResponse(
    providerBody,
    request.signal,
    authOverride,
    request.onProviderStreamEvent,
    {
      attribution: request.usageAttribution,
      roundIndex,
      butlerData: request.butlerData,
      routeTransportAttemptOrdinal: request.routeTransportAttemptOrdinal ?? 0,
      attributionArmId: request.attributionArmId,
      segmentManifests,
      cacheBoundaryEvidence: request.cacheBoundaryEvidence,
      admitBoundedProviderBody: request.boundedContinuation?.admitProviderBody,
      stableProviderCachePrefix: request.stableProviderCachePrefix,
      routeContext: request.routeContext,
      previousProviderRouteIdentity: previous?.providerRouteIdentity,
      onProviderRouteCacheIdentity: (established) => {
        if (providerCacheIdentity &&
            JSON.stringify(providerCacheIdentity) !== JSON.stringify(established.identity)) {
          throw stableProviderPrefixInvariant("stable_provider_prefix_retry_identity_changed");
        }
        providerCacheIdentity = established.identity;
      },
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
  const boundedContinuation = request.boundedContinuation;
  const bounded = Boolean(boundedContinuation);
  const nextContinuation: OpenAIRequestSegmentContinuation = {
    provider: "openai",
    responseId: response.id,
    ...(providerCacheIdentity
      ? { providerRouteIdentity: providerCacheIdentity }
      : {}),
    ...(boundedStatelessInput
      ? { deliveredThroughOrdinal: responseOrdinal }
      : { sent: continuationMessages?.sent ?? { toolMessages: 0, userMessages: 1 } }),
    ...(!bounded
      ? {
          statelessInput,
          statelessManifest: appendOpenAIFunctionCallContinuityManifest(
            segmentManifests.continuation,
            functionCalls,
            statelessRequestInput.length,
          ),
        }
      : {}),
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

function projectAcknowledgedToolOutputs(
  previous: readonly Record<string, unknown>[],
  messages: readonly ModelRoundMessage[],
): Array<Record<string, unknown>> {
  const references = new Map(messages.flatMap((message) =>
    message.role === "tool" && message.toolCallId && message.operationResultReference
      ? [[message.toolCallId, message.content] as const]
      : [],
  ));
  if (references.size === 0) return [...previous];
  return previous.map((item) => {
    if (item.type !== "function_call_output" || typeof item.call_id !== "string") {
      return item;
    }
    const output = references.get(item.call_id);
    return output === undefined ? item : { ...item, output };
  });
}

function requiredLegacyStatelessInput(
  value: OpenAIRequestSegmentContinuation["statelessInput"],
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("openai_stateless_continuation_missing");
  return value;
}

function newOpenAIContinuationMessages(
  messages: readonly ModelRoundMessage[],
  alreadySent: NonNullable<OpenAIRequestSegmentContinuation["sent"]>,
  butlerData?: string,
): {
  items: Array<Record<string, unknown>>;
  statelessItems: Array<Record<string, unknown>>;
  itemKinds: Array<M1RequestSegmentKind | undefined>;
  sent: OpenAIRequestSegmentContinuation["sent"];
} {
  const items: Array<Record<string, unknown>> = [];
  const statelessItems: Array<Record<string, unknown>> = [];
  const itemKinds: Array<M1RequestSegmentKind | undefined> = [];
  let toolMessages = 0;
  let userMessages = 0;
  for (const message of messages) {
    if (message.role === "tool") {
      toolMessages += 1;
      if (toolMessages <= alreadySent.toolMessages) continue;
      const [item, statelessItem] = openAIToolMessageItems(message, butlerData);
      items.push(item);
      statelessItems.push(statelessItem);
      itemKinds.push(message.requestSegmentKind ?? "latest_tool_result_delivery");
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
    itemKinds.push(message.requestSegmentKind ?? "other_typed_context");
  }
  return { items, statelessItems, itemKinds, sent: { toolMessages, userMessages } };
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
