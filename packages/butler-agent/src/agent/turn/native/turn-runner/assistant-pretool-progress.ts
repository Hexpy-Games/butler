import {
  buildIntermediateAction,
  emitIntermediateBestEffort,
} from "../progress/turn-delivery-events.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import { publicWorkDecisionsFromAssistantText } from "../../../output/public-work/decisions.ts";

function compactForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function leaksInternalExecutionPlan(input: {
  text: string;
  rawTasks: string[];
}): boolean {
  const text = compactForComparison(input.text);
  if (!text) return true;
  if (text.length > 700) return true;
  if (/\btask[_ -]?id\b/i.test(input.text)) return true;
  if (/dispatch_worker|resume_worker/i.test(input.text)) return true;
  for (const rawTask of input.rawTasks) {
    const task = compactForComparison(rawTask);
    if (task.length >= 40 && text.includes(task.slice(0, 40))) return true;
  }
  return false;
}

export async function emitAssistantTextBeforeTools(input: {
  turnInput: RuntimeTurnInput;
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  language: RuntimeMessageLanguage;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  const workerStartCalls = input.toolCalls.filter((call) =>
    call.name === "dispatch_worker" || call.name === "resume_worker",
  );
  const rawTasks = workerStartCalls.flatMap((call) => {
    const task = call.args.task;
    return typeof task === "string" && task.trim() ? [task.trim()] : [];
  });
  if (leaksInternalExecutionPlan({ text: input.text, rawTasks })) return;
  const text = visiblePreToolText(input);
  if (!text) return;
  await emitIntermediateBestEffort(
    input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: `${input.toolCalls.map((call) => call.name).join("-")}-start`,
      text,
      metadata: {
        tool: input.toolCalls.map((call) => call.name).join(","),
        phase: "before_tool_execution",
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#assistant-plan",
      tool: input.toolCalls.map((call) => call.name).join(","),
    },
  );
}

function visiblePreToolText(input: {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  language: RuntimeMessageLanguage;
}): string {
  const decisions = publicWorkDecisionsFromAssistantText({
    text: input.text,
    toolCalls: input.toolCalls,
    language: input.language,
    existingDecisions: [],
  });
  const first = decisions[0];
  if (first?.summary) {
    return [first.summary, first.nextStep].filter(Boolean).join("\n");
  }
  if (
    input.toolCalls.some((call) =>
      call.name === "dispatch_worker" || call.name === "resume_worker",
    )
  ) {
    return input.text.trim();
  }
  return "";
}
