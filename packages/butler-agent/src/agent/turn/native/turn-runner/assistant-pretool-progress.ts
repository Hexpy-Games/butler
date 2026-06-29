import { createHash } from "node:crypto";
import {
  buildIntermediateAction,
  emitIntermediateBestEffort,
} from "../progress/turn-delivery-events.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import { publicWorkDecisionsFromAssistantText } from "../../../output/public-work/decisions.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";

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
  const note = visiblePreToolWorkNote(input);
  if (!note) return;
  const workBlockId = publicNoteWorkBlockId(note.text);
  await emitIntermediateBestEffort(
    input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: `${input.toolCalls.map((call) => call.name).join("-")}-start`,
      text: note.text,
      metadata: {
        tool: input.toolCalls.map((call) => call.name).join(","),
        phase: "before_tool_execution",
        workBlockId,
        workBlockLabel: note.text,
        ...(note.decision
          ? {
            decisionSummary: note.decision.summary,
            decisionRationale: note.decision.rationale,
            decisionNextStep: note.decision.nextStep,
            decisionSource: note.decision.source,
            decisionEvidenceRefs: note.decision.evidenceRefs,
          }
          : {}),
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#assistant-plan",
      tool: input.toolCalls.map((call) => call.name).join(","),
    },
  );
}

function visiblePreToolWorkNote(input: {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  language: RuntimeMessageLanguage;
}): { text: string; decision?: PublicWorkDecision } | null {
  const decisions = publicWorkDecisionsFromAssistantText({
    text: input.text,
    toolCalls: input.toolCalls,
    language: input.language,
    existingDecisions: [],
  });
  const first = decisions[0];
  if (first?.summary) {
    return {
      text: [first.summary, first.nextStep].filter(Boolean).join("\n"),
      decision: first,
    };
  }
  if (
    input.toolCalls.some((call) =>
      call.name === "dispatch_worker" || call.name === "resume_worker",
    )
  ) {
    const text = input.text.trim();
    return text ? { text } : null;
  }
  return null;
}

function publicNoteWorkBlockId(text: string): string {
  const digest = createHash("sha1")
    .update(compactForComparison(text))
    .digest("hex")
    .slice(0, 12);
  return `public-note-${digest}`;
}
