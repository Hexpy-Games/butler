import type {
  BtccAgentLoopMessage, BtccAgentLoopToolCall, BtccAgentLoopToolDefinition,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import type { StableProviderCachePrefixContract } from "../ports/model-round.ts";
import type { GuidedActivitySnapshot } from "../projection/projection.ts";

/** Private cursor at an accepted tool batch. Pending is not a provider result. */
export type AuthorityLoopContinuation = {
  requestRef: string;
  callId: string;
  messages: BtccAgentLoopMessage[];
  nextItemOrdinal: number;
  providerContinuation?: unknown;
  instructions?: string;
  stableProviderCachePrefix?: StableProviderCachePrefixContract;
  modelRoundIndex: number;
  iteration: number;
  emptyResponseRecoveryUsed: boolean;
  toolResults: BtccAgentLoopToolResult[];
  presentation?: { sourceRevision: number; activity: GuidedActivitySnapshot };
  batch: {
    tools: readonly BtccAgentLoopToolDefinition[];
    calls: BtccAgentLoopToolCall[];
    nextCallIndex: number;
    results: BtccAgentLoopToolResult[];
  };
};

export type AuthorityLoopDecision =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "modify"; input: string };

export function pendingAuthority(value: unknown): { requestRef: string } | undefined {
  if (!value || typeof value !== "object" || !("authority_pending" in value) ||
      value.authority_pending !== true || !("request_ref" in value) ||
      typeof value.request_ref !== "string") return undefined;
  return { requestRef: value.request_ref };
}

export function unexecutedAuthorityCall(
  call: BtccAgentLoopToolCall,
  decision: Exclude<AuthorityLoopDecision, { action: "allow" }>,
  isPendingCall: boolean,
): BtccAgentLoopToolResult {
  return {
    toolCallId: call.id, name: call.name, ok: false,
    error: {
      code: isPendingCall ? `authority_request_${decision.action === "deny" ? "denied" : "modified"}` : "tool_batch_not_executed",
      message: isPendingCall
        ? decision.action === "deny"
          ? "The user denied this operation. It was not executed."
          : "The user requested a change. This operation was not executed."
        : "Not executed because the user changed or denied an earlier operation in this batch.",
    },
  };
}
