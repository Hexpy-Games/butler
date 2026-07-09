import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import { estimateContextTokens } from "../../../context/budget.ts";
import type { PromptUsageSectionAttribution } from "../../../../integrations/providers/provider.ts";
import { metadataPolicyValue } from "../policy/turn-metadata-policy.ts";
import { promptContextSection } from "../context/turn-prompt.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { NativeStoredSessionConfig } from "./turn-runner-types.ts";

const THIN_TOOL_INTENT_START = "<butler_tool_intent>";
const THIN_TOOL_INTENT_END = "</butler_tool_intent>";
const THIN_RECENT_CONVERSATION_MAX_CHARS = 6_000;
const THIN_PERSONA_MAX_CHARS = 2_000;

export interface ThinToolIntent {
  summary: string;
  rationale: string;
  nextStep: string;
  raw: string;
}

export interface ThinFirstResponsePrompt {
  prompt: string;
  promptSections: PromptUsageSectionAttribution[];
}

export function shouldUseThinFirstResponse(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  plannedReview: PlannedReviewTurnContext | null;
}): boolean {
  if (input.session.init.role !== "butler") return false;
  if (input.plannedReview) return false;
  if (hasSchedulerContinuation(input.turnInput.metadata)) return false;
  if (hasExplicitRequiredTools(input.turnInput.metadata)) return false;
  const camel = metadataPolicyValue(input.turnInput.metadata, "thinFirstResponse");
  const snake = metadataPolicyValue(input.turnInput.metadata, "thin_first_response");
  const value = camel ?? snake;
  return value === true || value === "enabled" || value === "app_default";
}

export function buildThinFirstResponsePrompt(input: {
  fullPrompt: string;
  userText: string;
}): ThinFirstResponsePrompt {
  const persona = takeSection(
    promptContextSection(input.fullPrompt, "Active Persona Reminder"),
    THIN_PERSONA_MAX_CHARS,
  );
  const recentConversation = takeSection(
    promptContextSection(input.fullPrompt, "Recent Conversation"),
    THIN_RECENT_CONVERSATION_MAX_CHARS,
  );
  const instructions = [
    "## Thin First Response Pass",
    "This hidden pass decides whether the current Butler turn can be answered immediately without tools.",
    "Use only the active persona, recent conversation, and current user request included here.",
    "If those materials are enough, answer the user directly in the user's language.",
    "If the user is asking for current workspace files, logs, commands, web/current facts, source verification, artifact edits, or durable multi-step work, return only this intent block:",
    THIN_TOOL_INTENT_START,
    "summary: one concise public-facing action summary",
    "rationale: why tool-backed evidence or action is needed now",
    "next_step: the immediate small step to announce before the first tool call",
    THIN_TOOL_INTENT_END,
    "Do not mention this hidden pass.",
  ].join("\n");
  const currentRequest = [
    "## Current User Request",
    input.userText.trim(),
  ].join("\n");
  const parts = [
    instructions,
    persona,
    recentConversation,
    currentRequest,
  ].filter((part) => part.trim());
  return {
    prompt: parts.join("\n\n"),
    promptSections: promptSections([
      ["thin_first_response_instructions", instructions],
      ["active_persona_reminder", persona],
      ["recent_conversation", recentConversation],
      ["inbound_message", currentRequest],
    ]),
  };
}

export function extractThinToolIntent(text: string): ThinToolIntent | null {
  const raw = intentBody(text);
  if (!raw) return null;
  return {
    summary: field(raw, "summary") || "도구로 확인할 작업을 준비합니다.",
    rationale: field(raw, "rationale") || "현재 요청은 포함된 대화 맥락만으로 확정하기 어렵습니다.",
    nextStep: field(raw, "next_step") || "필요한 근거를 확인합니다.",
    raw,
  };
}

export function toolEscalationPrompt(input: {
  prompt: string;
  intent: ThinToolIntent;
}): string {
  return [
    input.prompt,
    [
      "## Hidden Thin First Response Escalation",
      "A previous hidden no-tool pass determined that this turn needs tool-backed work.",
      "Use this as the seed for the next public work decision, then continue through the normal tool path.",
      `summary: ${input.intent.summary}`,
      `rationale: ${input.intent.rationale}`,
      `next_step: ${input.intent.nextStep}`,
      "Before the first tool call, emit a fresh public decision for the immediate small step.",
    ].join("\n"),
  ].join("\n\n");
}

function intentBody(text: string): string | null {
  const start = text.indexOf(THIN_TOOL_INTENT_START);
  if (start < 0) return null;
  const bodyStart = start + THIN_TOOL_INTENT_START.length;
  const end = text.indexOf(THIN_TOOL_INTENT_END, bodyStart);
  const body = end >= 0 ? text.slice(bodyStart, end) : text.slice(bodyStart);
  return body.trim() || null;
}

function field(raw: string, name: "summary" | "rationale" | "next_step"): string {
  const match = new RegExp(`(?:^|\\n)${name}:\\s*([^\\n]+)`, "u").exec(raw);
  return match?.[1]?.trim() ?? "";
}

function takeSection(section: string, maxChars: number): string {
  const trimmed = section.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[...trimmed for thin first response...]`;
}

function promptSections(
  sections: Array<[id: string, content: string]>,
): PromptUsageSectionAttribution[] {
  return sections
    .filter(([, content]) => content.trim().length > 0)
    .map(([id, content]) => ({
      id,
      chars: content.length,
      estimatedTokens: estimateContextTokens(content),
    }));
}

function hasSchedulerContinuation(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return Boolean(record.schedulerContinuation && typeof record.schedulerContinuation === "object");
}

function hasExplicitRequiredTools(metadata: unknown): boolean {
  const raw = [
    metadataPolicyValue(metadata, "requiredNativeTools"),
    metadataPolicyValue(metadata, "required_tools"),
  ];
  return raw.some((value) =>
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && item.trim().length > 0),
  );
}
