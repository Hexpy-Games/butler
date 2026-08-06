import { runBtccAgentLoop } from "./agent-loop.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";
import { ModelProviderRequestError } from
  "../../../integrations/providers/provider-errors.ts";
import {
  guidedOperationalFallback,
  type OperationalFacts,
} from "./guided-operational-facts.ts";

export {
  guidedOperationalFallback,
  guidedOperationalReportPrompt,
  type OperationalFacts,
} from "./guided-operational-facts.ts";

/** Operational failure handling around the BTCC-owned semantic loop. */
export async function runGuidedAgentLoopWithOperationalReport(input: {
  options: BtccAgentLoopInput;
  parentSignal: AbortSignal;
  originalRequest: string;
  loadFacts: () => Promise<Omit<OperationalFacts, "originalRequest">>;
}): Promise<string> {
  try {
    const result = await runBtccAgentLoop({
      ...input.options,
      signal: input.parentSignal,
    });
    const candidate = result.finalText.trim();
    if (candidate) return candidate;
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
