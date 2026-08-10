import type { DurableWorkContext, DurableWorkView } from "../work/index.ts";

export function renderExecutionWindowObservation(input: {
  windowIndex: number;
  context: DurableWorkContext | null;
  boundWork: DurableWorkView | null;
}): string {
  const work = input.context?.work ?? input.boundWork;
  const lines = [
    `Execution checkpoint ${input.windowIndex + 1}: use the existing conversation and evidence already collected for the original request.`,
  ];
  if (!work) {
    lines.push(
      "No durable Work checkpoint is available. Preserve the prior messages and evaluate the next useful step from the evidence already present.",
    );
    return lines.join("\n");
  }
  lines.push(`Durable Work status: ${work.status}.`);
  if (work.currentStage) lines.push(`Current stage: ${work.currentStage}.`);
  if (work.latestCheckpoint?.publicSummary) {
    lines.push(`Latest checkpoint: ${singleLine(work.latestCheckpoint.publicSummary, 600)}`);
  }
  if (work.latestCheckpoint?.nextStep) {
    lines.push(`Recorded next step: ${singleLine(work.latestCheckpoint.nextStep, 400)}`);
  }
  lines.push(
    "Use this checkpoint with the existing tool results and produce the final answer only when the requested outcome is supported.",
  );
  return lines.join("\n");
}

/** Mechanical recovery facts used only by the compact replay arm. */
export function renderCompactExecutionWindowObservation(input: {
  windowIndex: number;
  context: DurableWorkContext | null;
  boundWork: DurableWorkView | null;
}): string {
  const work = input.context?.work ?? input.boundWork;
  const lines = [
    `Execution checkpoint ${input.windowIndex + 1}: preserve the existing request and durable result references.`,
  ];
  if (!work) {
    lines.push("Durable Work status: unavailable.");
    return lines.join("\n");
  }
  lines.push(`Durable Work status: ${work.status}.`);
  if (work.currentStage) lines.push(`Current stage: ${work.currentStage}.`);
  lines.push(
    `Plan revision: ${work.currentPlan?.revision ?? null}.`,
    `Checkpoint revision: ${work.latestCheckpoint?.revision ?? null}.`,
    `Result revision: ${work.resultRefs.length}.`,
    `Required result refs: ${work.resultRefs.map((result) => result.resultRef).join(", ") || "none"}.`,
  );
  return lines.join("\n");
}

export function renderGuidedExecutionWindowObservation(input: {
  compactReplayEnabled: boolean;
  windowIndex: number;
  context: DurableWorkContext | null;
  boundWork: DurableWorkView | null;
}): string {
  return input.compactReplayEnabled
    ? renderCompactExecutionWindowObservation(input)
    : renderExecutionWindowObservation(input);
}

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}
