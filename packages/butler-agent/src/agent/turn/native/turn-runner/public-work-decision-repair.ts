import type { PublicWorkDecisionEnvelope } from "../../../output/public-work/decisions.ts";
import type { PublicWorkDecision, PublicWorkObligationKind } from "../output/tool-types.ts";
import type { PrivateTurnDecisionValidation } from "./private-turn-decision-prompt.ts";

const REPAIR_TOOL_NAME = "submit_work_block_decision";
const REPEAT_REASONS = new Set(["polling", "transient_retry", "race_confirmation"]);
const COMPLETION_OBLIGATIONS = new Set<PublicWorkObligationKind>([
  "source_verified",
  "command_executed",
  "durable_artifact",
  "data_table_created",
  "chart_rendered",
]);

export function publicWorkDecisionRepairToolName(): string {
  return REPAIR_TOOL_NAME;
}

export function publicWorkDecisionRepairResponseFormat(): { schema: Record<string, unknown> } {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["block_title", "objective", "rationale", "next_step"],
      properties: {
        block_title: { type: "string", minLength: 2, maxLength: 96 },
        objective: { type: "string", minLength: 8, maxLength: 500 },
        rationale: { type: "string", minLength: 8, maxLength: 500 },
        next_step: { type: "string", minLength: 8, maxLength: 500 },
        expected_effect: { type: "string", minLength: 4, maxLength: 500 },
        repeat_reason: {
          anyOf: [
            { type: "string", enum: Array.from(REPEAT_REASONS) },
            { type: "null" },
          ],
        },
        completion_obligations: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", enum: Array.from(COMPLETION_OBLIGATIONS) },
          maxItems: COMPLETION_OBLIGATIONS.size,
        },
      },
    },
  };
}

export function publicWorkDecisionRepairPrompt(input: {
  contractObjective: string;
  previousDecision?: PublicWorkDecision;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}): string {
  const previous = input.previousDecision
    ? `${input.previousDecision.blockTitle ?? "Previous work"}: ${input.previousDecision.summary}`
    : "none";
  return [
    "Author the one visible decision envelope for the already selected semantic tool batch.",
    `Active contract objective: ${input.contractObjective}`,
    `Previous decision: ${previous}`,
    "Already selected tools (stable order):",
    JSON.stringify(input.toolCalls),
    "The tools are already selected. Do not replace, add, or execute them in this response.",
    "Use one concise block_title naming the immediate work. It must not copy the full objective.",
    "Explain why this exact batch is the next useful step, what follows after its results, and the expected state or evidence change.",
    `Submit exactly one envelope through ${REPAIR_TOOL_NAME}.`,
  ].join("\n\n");
}

export function validatePublicWorkDecisionRepair(
  args: Record<string, unknown>,
): PrivateTurnDecisionValidation {
  const canonicalArgs = canonicalPublicWorkDecisionArgs(args);
  const envelope = publicWorkDecisionEnvelopeFromRecord(canonicalArgs);
  if (!envelope) {
    return {
      ok: false,
      errorCode: "public_work_decision_invalid",
      correction: "Provide distinct non-empty block_title, objective, rationale, next_step, and expected_effect fields.",
      canonicalArgs,
    };
  }
  return { ok: true, canonicalArgs };
}

export function parsePublicWorkDecisionRepair(raw: string): PublicWorkDecisionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("public_work_decision_repair_invalid_json");
  }
  const envelope = publicWorkDecisionEnvelopeFromRecord(record(parsed));
  if (!envelope) throw new Error("public_work_decision_repair_invalid");
  return envelope;
}

function canonicalPublicWorkDecisionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const blockTitle = boundedBlockTitle(text(args.block_title));
  const repeatReason = text(args.repeat_reason);
  const completionObligations = Array.isArray(args.completion_obligations)
    ? args.completion_obligations.filter((value): value is PublicWorkObligationKind =>
      typeof value === "string" && COMPLETION_OBLIGATIONS.has(value as PublicWorkObligationKind),
    )
    : [];
  return {
    block_title: blockTitle,
    objective: text(args.objective),
    rationale: text(args.rationale),
    next_step: text(args.next_step),
    expected_effect: text(args.expected_effect) || text(args.next_step),
    repeat_reason: repeatReason && REPEAT_REASONS.has(repeatReason) ? repeatReason : null,
    completion_obligations: completionObligations,
  };
}

function boundedBlockTitle(value: string): string {
  if (value.length <= 96) return value;
  return `${value.slice(0, 93).trimEnd()}...`;
}

function publicWorkDecisionEnvelopeFromRecord(
  value: Record<string, unknown>,
): PublicWorkDecisionEnvelope | null {
  const blockTitle = text(value.block_title);
  const summary = text(value.objective);
  const rationale = text(value.rationale);
  const nextStep = text(value.next_step);
  const expectedEffect = text(value.expected_effect);
  if (
    blockTitle.length < 2 || blockTitle.length > 96 ||
    summary.length < 8 || rationale.length < 8 || nextStep.length < 8 || expectedEffect.length < 4 ||
    normalized(blockTitle) === normalized(summary)
  ) return null;
  const repeatReason = text(value.repeat_reason);
  const completionObligations = Array.isArray(value.completion_obligations)
    ? value.completion_obligations.filter((item): item is PublicWorkObligationKind =>
      typeof item === "string" && COMPLETION_OBLIGATIONS.has(item as PublicWorkObligationKind),
    )
    : [];
  return {
    blockTitle,
    summary,
    rationale,
    nextStep,
    expectedEffect,
    ...(REPEAT_REASONS.has(repeatReason)
      ? { repeatReason: repeatReason as PublicWorkDecisionEnvelope["repeatReason"] }
      : {}),
    completionObligations,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}
