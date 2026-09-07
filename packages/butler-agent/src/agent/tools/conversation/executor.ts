import type { ButlerToolExecutorInput, ButlerToolHandler } from "../butler-tool-executor-contracts.ts";
import { resolveAppGatewayRuntimeConfig } from "../../../operations/gateway/registry.ts";
import { readLocalAuthConfigFromEnvironment } from "../../../gateways/app/interface/server/local-auth.ts";

export function createStartTopicConversationHandler(input: ButlerToolExecutorInput): ButlerToolHandler {
  return (call, context) => executeTopicConversation({ butlerData: input.butlerData,
    appSessionId: input.appSessionId, args: call.args,
    requestId: context?.effectOccurrenceId ?? call.providerCallId, signal: call.signal });
}

export async function executeTopicConversation(input: {
  butlerData: string; appSessionId?: string; args: Record<string, unknown>;
  requestId?: string; signal?: AbortSignal;
}): Promise<unknown> {
    if (!input.requestId) throw new Error("session_branch_request_identity_required");
    const auth = readLocalAuthConfigFromEnvironment();
    if (auth.required && !auth.token) throw new Error("app_local_auth_unconfigured");
    const url = new URL("/internal/session-branches", resolveAppGatewayRuntimeConfig({ butlerData: input.butlerData }).serverUrl);
    const response = await fetch(url, {
      method: "POST", signal: input.signal,
      headers: { "content-type": "application/json", ...(auth.required ? { authorization: `Bearer ${auth.token}` } : {}) },
      body: JSON.stringify({ ...input.args, request_id: input.requestId,
        current_session_id: input.appSessionId }),
    });
    const result = await response.json() as { data?: unknown; error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? "새 대화를 만들지 못했습니다.");
    if (!result.data || typeof result.data !== "object") throw new Error("새 대화 생성 결과를 확인하지 못했습니다.");
    return result.data;
}
