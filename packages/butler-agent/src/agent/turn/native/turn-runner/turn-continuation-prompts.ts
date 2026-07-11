import type { ActiveTurnContract } from "./turn-contract-runtime.ts";

export interface CompletionContinuationPromptInput {
  userText: string;
  activeTurnContract: ActiveTurnContract | null;
  observationSummary: string;
  modelVisibleContent: string;
  continuationEvidence: string;
}

export function completionGapContinuationPrompt(
  input: CompletionContinuationPromptInput,
): string {
  const active = input.activeTurnContract;
  return [
    "The Turn Kernel recorded a model-visible observation for this same logical turn.",
    "Do not deliver final text yet. Continue the current work from the observation.",
    `Current user request: ${input.userText}`,
    ...(active
      ? [
        `Active contract: ${active.contract.contract_id}`,
        `Action: ${active.contract.action}`,
        `Required deliverables: ${active.contract.deliverables.join(", ") || "none"}`,
        `Current objective: ${active.decision.public_summary}`,
        `Prior next step: ${active.decision.immediate_next_step ?? "none"}`,
      ]
      : []),
    `Observation: ${input.observationSummary}`,
    input.modelVisibleContent,
    input.continuationEvidence,
    "Author one fresh public decision for the next small objective before requesting more tools.",
  ].filter(Boolean).join("\n\n");
}

export function completionGapFinalSynthesisPrompt(
  input: CompletionContinuationPromptInput,
): string {
  const active = input.activeTurnContract;
  return [
    "The Turn Kernel recorded verified evidence for this same logical turn.",
    `Current user request: ${input.userText}`,
    ...(active
      ? [
        `Active contract: ${active.contract.contract_id}`,
        `Action: ${active.contract.action}`,
        `Required deliverables: ${active.contract.deliverables.join(", ") || "none"}`,
        `Current objective: ${active.decision.public_summary}`,
      ]
      : []),
    `Observation: ${input.observationSummary}`,
    input.modelVisibleContent,
    input.continuationEvidence,
    "Produce the concise user-facing final answer now from the verified evidence. Preserve the active persona and configured response language.",
  ].filter(Boolean).join("\n\n");
}
