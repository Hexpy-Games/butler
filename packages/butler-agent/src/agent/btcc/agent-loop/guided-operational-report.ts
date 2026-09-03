import { runBtccAgentLoop } from "./agent-loop.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";
import type { BtccEmptyResponsePolicy } from "../contracts.ts";
import { ModelProviderRequestError } from
  "../../../integrations/providers/provider-errors.ts";
import {
  guidedOperationalFallback,
  type OperationalFacts,
} from "./guided-operational-facts.ts";

export {
  guidedOperationalFallback,
  type OperationalFacts,
} from "./guided-operational-facts.ts";

/** Operational failure handling around the BTCC-owned semantic loop. */
export async function runGuidedAgentLoopWithOperationalReport(input: {
  options: BtccAgentLoopInput;
  parentSignal: AbortSignal;
  originalRequest: string;
  emptyResponsePolicy?: BtccEmptyResponsePolicy;
  loadFacts: () => Promise<Omit<OperationalFacts, "originalRequest">>;
  onExecutionWait?: () => void;
}): Promise<string> {
  try {
    const result = await runBtccAgentLoop({
      ...input.options,
      signal: input.parentSignal,
    });
    const candidate = result.finalText.trim();
    if (result.executionOutcome === "waiting_for_worker") {
      input.onExecutionWait?.();
      return "";
    }
    // An empty result is a genuine terminal no-visible outcome.
    // Preserve it for the transport dispatcher to emit its typed queue
    // failure; converting it into an assistant fallback would hide the
    // durable input settlement obligation.
    if (candidate || input.emptyResponsePolicy === "typed_terminal") return candidate;
  } catch (error) {
    if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
    if (!allowsOperationalReport(error)) throw error;
  }

  let facts: OperationalFacts = {
    originalRequest: input.originalRequest,
    work: null,
    toolCalls: [],
    effects: [],
  };
  try {
    throwIfAborted(input.parentSignal);
    facts = {
      originalRequest: input.originalRequest,
      ...await input.loadFacts(),
    };
  } catch {
    if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
  }
  const fallback = guidedOperationalFallback(facts);
  return fallback;
}

function allowsOperationalReport(error: unknown): boolean {
  return error instanceof ModelProviderRequestError && error.retryable;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
