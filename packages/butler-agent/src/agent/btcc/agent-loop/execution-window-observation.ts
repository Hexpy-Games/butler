import type {
  DurableWorkContext,
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import { safeBoundWork, safeLoadWorkContext } from "./guided-work-runtime.ts";

export function createGuidedExecutionWindowObserver(input: {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  turnId: string;
  trackingMode: "ledger" | "local" | "none";
  signal: AbortSignal;
}) {
  return async ({ windowIndex }: { windowIndex: number }) => {
    if (input.signal.aborted) throwGuidedAbort(input.signal);
    const context = input.trackingMode === "none"
      ? null
      : await safeLoadWorkContext(input.durableWork, input.workScope);
    const boundWork = input.trackingMode === "none"
      ? null
      : await safeBoundWork(input.durableWork, input.turnId);
    return renderExecutionWindowObservation({ windowIndex, context, boundWork });
  };
}

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

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function throwGuidedAbort(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
