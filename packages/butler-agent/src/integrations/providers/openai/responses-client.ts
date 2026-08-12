import type { OpenAIAuthOverride, OpenAIResponse, PromptUsageAttribution, ProviderStreamProjectionHandler } from "../runtime-contracts.ts";
import { abortError, getFunctionCalls, withModelApiRetry } from "../shared/runtime-support.ts";
import { createCodexResponse } from "./codex-stream.ts";
import { getResponsesUrl } from "./config.ts";
import { providerHttpError, providerNetworkError, providerRoundTimeoutError, safeEndpointLabel } from "../provider-errors.ts";
import { resolveOpenAIAuth } from "./auth.ts";
import { admitSerializedProviderRequest } from "../shared/request-context-admission.ts";
import {
  createProviderRoundGuard,
  raceProviderRoundWithSignal,
  type ProviderRoundPolicy,
} from "../shared/provider-round-guard.ts";
import {
  observeM1ProviderAttempt,
  M1_PHYSICAL_ATTEMPT_HEADER,
  finalizeM1ProviderAttempt,
  recordM1ResponseUsage,
} from "../shared/m1-segment-attribution.ts";
import type {
  M1CacheBoundaryEvidence,
  M1ProviderRequestSegmentManifestEntry,
} from "../../../agent/btcc/ports/provider-request-attribution.ts";

export interface OpenAIProviderBudgetContext {
  attribution?: PromptUsageAttribution;
  roundIndex: number;
  routeTransportAttemptOrdinal?: number;
  providerRetryOrdinal?: number;
  butlerData?: string;
  attributionArmId?: string;
  segmentManifests?: {
    official: readonly M1ProviderRequestSegmentManifestEntry[];
    codex: readonly M1ProviderRequestSegmentManifestEntry[];
  };
  cacheBoundaryEvidence?: M1CacheBoundaryEvidence;
  admitBoundedProviderBody?: (serializedBytes: number) => Promise<void>;
}




export async function createOpenAIResponse(
  body: Record<string, any>,
  signal?: AbortSignal,
  authOverride?: OpenAIAuthOverride,
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
  budgetContext?: OpenAIProviderBudgetContext,
  providerRoundPolicy?: Partial<ProviderRoundPolicy>,
  retryAttempts?: number,
): Promise<OpenAIResponse> {
  const auth = authOverride ?? await resolveOpenAIAuth();
  const guard = createProviderRoundGuard({
    signal,
    policy: openAIProviderRoundPolicy(providerRoundPolicy),
  });
  let providerRetryOrdinal = 0;
  try {
    return await raceProviderRoundWithSignal(
      withModelApiRetry(
        async () => await createOpenAIResponseOnce(
          body,
          guard.signal,
          auth,
          onProviderStreamEvent,
          {
            ...budgetContext,
            roundIndex: budgetContext?.roundIndex ?? 0,
            providerRetryOrdinal: providerRetryOrdinal++,
          },
          () => guard.recordProgress(),
          () => guard.start(),
        ),
        guard.signal,
        retryAttempts,
      ),
      guard.signal,
    );
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (guard.timeoutKind) {
      const codex = auth?.mode === "codex_subscription" || auth?.mode === "codex_oauth";
      throw providerRoundTimeoutError({
        provider: codex ? "openai-codex" : "openai",
        api: codex ? "codex_responses" : "responses",
        timeoutKind: guard.timeoutKind,
        model: typeof body.model === "string" ? body.model : undefined,
      });
    }
    throw error;
  } finally {
    guard.dispose();
  }
}

function openAIProviderRoundPolicy(
  policy?: Partial<ProviderRoundPolicy>,
): Partial<ProviderRoundPolicy> | undefined {
  if (policy?.idleTimeoutMs !== undefined) return policy;
  return { ...policy, idleTimeoutMs: null };
}




export async function createOpenAIResponseOnce(
  body: Record<string, any>,
  signal?: AbortSignal,
  authOverride?: OpenAIAuthOverride,
  onProviderStreamEvent?: ProviderStreamProjectionHandler,
  budgetContext?: OpenAIProviderBudgetContext,
  onProviderRoundProgress?: () => void,
  onProviderRoundStarted?: () => void,
): Promise<OpenAIResponse> {
  const auth = authOverride ?? await resolveOpenAIAuth();
  if (auth.mode === "codex_subscription" || auth.mode === "codex_oauth") {
    return await createCodexResponse(
      body,
      auth.authorization,
      signal,
      onProviderStreamEvent,
      budgetContext,
      onProviderRoundProgress,
      onProviderRoundStarted,
    );
  }
  const { __butler_codex_stateless_input: _codexStatelessInput, ...rawOfficialBody } = body;
  const officialBody: Record<string, any> = {
    ...(budgetContext?.attribution?.requestedOutputTokens && rawOfficialBody.max_output_tokens === undefined
      ? { max_output_tokens: budgetContext.attribution.requestedOutputTokens }
      : {}),
    ...rawOfficialBody,
  };
  const endpoint = safeEndpointLabel(getResponsesUrl());
  const model = typeof officialBody.model === "string" ? officialBody.model : undefined;
  const admittedRequest = admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: model ?? "",
    body: officialBody,
    requestedOutputTokens: typeof officialBody.max_output_tokens === "number"
      ? officialBody.max_output_tokens
      : undefined,
    usageAttribution: budgetContext?.attribution,
    roundIndex: budgetContext?.roundIndex,
  });
  const observedRequest = observeM1ProviderAttempt({
    providerId: "openai",
    modelRef: admittedRequest.plan.model_ref,
    body: officialBody,
    turnId: budgetContext?.attribution?.turnId,
    phase: budgetContext?.attribution?.phase,
    roundIndex: budgetContext?.roundIndex ?? 0,
    routeTransportAttemptOrdinal: budgetContext?.routeTransportAttemptOrdinal ?? 0,
    providerRetryOrdinal: budgetContext?.providerRetryOrdinal ?? 0,
    estimatedInputTokens: admittedRequest.plan.compiled_input_tokens,
    armId: budgetContext?.attributionArmId,
    segmentManifest: budgetContext?.segmentManifests?.official,
    butlerData: budgetContext?.butlerData,
    deferRecord: true,
    cacheBoundaryRevision: budgetContext?.cacheBoundaryEvidence?.observedRevision,
  });
  await budgetContext?.admitBoundedProviderBody?.(
    Buffer.byteLength(observedRequest.serializedRequest, "utf8"),
  );

  let response: Response;
  try {
    onProviderRoundStarted?.();
    response = await fetch(getResponsesUrl(), {
      method: "POST",
      headers: {
        Authorization: auth.authorization,
        "Content-Type": "application/json",
        ...(observedRequest.observation
          ? { [M1_PHYSICAL_ATTEMPT_HEADER]: observedRequest.observation.envelope.attemptDigest }
          : {}),
      },
      body: observedRequest.serializedRequest,
      signal,
    });
  } catch (error) {
    finalizeOpenAIAttempt(observedRequest.observation, budgetContext, "rejected");
    throw providerNetworkError({
      provider: "openai",
      api: "responses",
      endpoint,
      model,
      error,
    });
  }

  onProviderRoundProgress?.();

  if (!response.ok) {
    const raw = await response.text();
    let parsed: Record<string, any> = {};
    let detail = raw;
    try {
      parsed = JSON.parse(raw);
      detail = parsed?.error?.message || raw;
    } catch {}
    finalizeOpenAIAttempt(observedRequest.observation, budgetContext, "rejected");
    throw providerHttpError({
      provider: "openai",
      api: "responses",
      statusCode: response.status,
      detail,
      providerError: parsed,
      endpoint,
      model,
      admission: admittedRequest,
      headers: response.headers,
    });
  }

  let parsed: OpenAIResponse;
  try {
    parsed = (await response.json()) as OpenAIResponse;
  } catch (error) {
    finalizeOpenAIAttempt(observedRequest.observation, budgetContext, "rejected");
    throw error;
  }
  finalizeOpenAIAttempt(
    observedRequest.observation,
    budgetContext,
    parsed.usage ? "eligible" : "usage_unavailable",
  );
  recordM1ResponseUsage({
    attemptDigest: observedRequest.observation?.envelope.attemptDigest,
    response: parsed,
    butlerData: budgetContext?.butlerData,
  });
  return parsed;
}

function finalizeOpenAIAttempt(
  observation: ReturnType<typeof observeM1ProviderAttempt>["observation"],
  context: OpenAIProviderBudgetContext | undefined,
  terminal: "eligible" | "usage_unavailable" | "rejected",
): void {
  const eligibility = terminal === "rejected"
    ? "rejected"
    : (context?.routeTransportAttemptOrdinal ?? 0) > 0 ||
        (context?.providerRetryOrdinal ?? 0) > 0
      ? "retry_contaminated"
      : cacheBoundaryMismatch(context?.cacheBoundaryEvidence)
        ? "cache_mismatch"
        : terminal;
  finalizeM1ProviderAttempt({
    observation,
    eligibility,
    butlerData: context?.butlerData,
  });
}

function cacheBoundaryMismatch(evidence: M1CacheBoundaryEvidence | undefined): boolean {
  return Boolean(evidence && evidence.expectedRevision !== evidence.observedRevision);
}




export function decodeJwtPayload(token: string): Record<string, any> | null {
  const rawToken = token.replace(/^Bearer\s+/i, "");
  const part = rawToken.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}




export function codexAccountIdFromAuthorization(authorization: string): string {
  const payload = decodeJwtPayload(authorization);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object"
    ? (auth.chatgpt_account_id || auth.account_id)
    : undefined;
  if (typeof accountId === "string" && accountId) return accountId;
  throw new Error("Codex subscription token did not include a ChatGPT account id");
}




export function codexRequestBody(body: Record<string, any>): Record<string, any> {
  const rawInput = body.__butler_codex_stateless_input ?? body.input;
  const next: Record<string, any> = {
    ...body,
    model: codexSubscriptionModel(String(body.model || "")),
    instructions: typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions
      : "You are Butler, a helpful personal AI assistant.",
    input: codexInput(rawInput),
    store: false,
    stream: true,
  };
  delete next.previous_response_id;
  delete next.__butler_codex_stateless_input;
  delete next.prompt_cache_retention;
  if (!next.text) {
    next.text = { verbosity: "medium" };
  }
  return next;
}




export function codexSubscriptionModel(model: string): string {
  const trimmed = model.trim();
  if (/^gpt-\d+(?:\.\d+)*-codex$/i.test(trimmed)) {
    return trimmed.replace(/-codex$/i, "");
  }
  if (!trimmed) {
    throw new Error("Codex subscription model is required; no model fallback is allowed.");
  }
  return trimmed;
}




export function codexInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return [{
    role: "user",
    content: [{
      type: "input_text",
      text: input,
    }],
  }];
}




export function toCodexStatelessInput(input: unknown): Array<Record<string, unknown>> {
  const converted = codexInput(input);
  return Array.isArray(converted)
    ? converted.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}




export function functionCallContinuationItems(
  response: OpenAIResponse,
  allowedNames?: Set<string>,
): Array<Record<string, unknown>> {
  return getFunctionCalls(response, allowedNames).map((call) => ({
    type: "function_call",
    call_id: call.call_id,
    name: call.name,
    arguments: call.arguments,
  }));
}
