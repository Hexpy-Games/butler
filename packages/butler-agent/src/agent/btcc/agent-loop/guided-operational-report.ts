import { runBtccAgentLoop } from "./agent-loop.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";
import { ModelProviderRequestError } from
  "../../../integrations/providers/provider-errors.ts";
import {
  guidedOperationalFallback,
  guidedOperationalReportPrompt,
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
    if (result.finalText.trim()) return result.finalText;
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
  try {
    throwIfAborted(input.parentSignal);
    const result = await runBtccAgentLoop({
      ...input.options,
      prompt: guidedOperationalReportPrompt(facts),
      instructions: [
        input.options.instructions,
        "Write one concise, natural user-facing status answer using only the supplied facts.",
        "Preserve the active persona, user language, and preferred form of address.",
        "Do not expose internal Work records, stages, tools, journals, effects, ids, counts, schemas, or raw errors.",
        "Clearly say what is known, what remains, and whether the saved work can continue. Do not call tools.",
      ].filter(Boolean).join("\n\n"),
      signal: input.parentSignal,
      attachments: [],
      tools: [],
      maxIterations: 1,
      onExecutionWindowBoundary: undefined,
      providerRetryAttempts: 0,
      executeTool: rejectOperationalToolCall,
      onAssistantTextBeforeTools: undefined,
    });
    if (result.finalText.trim()) return result.finalText;
  } catch {
    if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
  }
  return fallback;
}

function allowsOperationalReport(error: unknown): boolean {
  return error instanceof ModelProviderRequestError;
}

async function rejectOperationalToolCall(): Promise<never> {
  throw new Error("Operational final report cannot call tools");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
