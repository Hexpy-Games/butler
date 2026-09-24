import type { ModelRoundPort } from "../ports/model-round.ts";
import type { ReasoningEffort } from "../../../integrations/providers/runtime-contracts.ts";
import type { BtccAgentLoopInput } from "./contracts.ts";
import { summaryMaxOutputTokens } from "./context-capacity.ts";
import { modelRoundOutputBytes } from "./bounded-turn-context.ts";
import { continuationRequestDigest } from "../turn/index.ts";

type SummaryBudget = Pick<NonNullable<BtccAgentLoopInput["continuationBudget"]>, "admitRequest" | "recordOutput">;

/**
 * Summary rounds use the selected model with a hard output cap derived from
 * the summary budget. Their cost is recorded in the continuation accounting,
 * which is honest bookkeeping only and never stops compaction.
 */
export function createGuidedContextSummarizer(input: {
  turnId: string;
  signal: AbortSignal;
  butlerData: string;
  resolveModelRef(): string;
  reasoningEffort?: ReasoningEffort;
  modelRound: Pick<ModelRoundPort, "runRound" | "contextSizing">;
  continuationBudget?: SummaryBudget;
}) {
  return async ({ text, maxOutputBytes, sourceDigest }: {
    text: string; maxOutputBytes: number; sourceDigest: string;
  }): Promise<string> => {
    const model = input.resolveModelRef();
    const capacity = input.modelRound.contextSizing?.({ model, tools: [], butlerData: input.butlerData });
    const roundId = `btcc-summary-${sourceDigest}`;
    const messages = [{ role: "user" as const, content: text }];
    await accountingOnly(() => input.continuationBudget?.admitRequest({
      roundId, requestDigest: continuationRequestDigest(messages),
      modelFacingBytes: Buffer.byteLength(JSON.stringify(messages), "utf8"),
    }));
    const response = await input.modelRound.runRound({
      roundId, model, messages, tools: [], signal: input.signal,
      reasoningEffort: input.reasoningEffort, butlerData: input.butlerData,
      maxOutputTokens: summaryMaxOutputTokens(maxOutputBytes, capacity),
      usageAttribution: { turnId: input.turnId, phase: "guided" },
    });
    await accountingOnly(() => input.continuationBudget?.recordOutput({
      roundId, outputBytes: modelRoundOutputBytes(response),
    }));
    return response.text ?? "";
  };
}

async function accountingOnly(record: () => Promise<void> | undefined): Promise<void> {
  try { await record(); } catch { /* Accounting never becomes a compaction limit. */ }
}
