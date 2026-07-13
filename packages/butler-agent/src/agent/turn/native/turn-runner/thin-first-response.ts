import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import { estimateContextTokens } from "../../../context/budget.ts";
import type { PromptUsageSectionAttribution } from "../../../../integrations/providers/provider.ts";
import { metadataPolicyValue } from "../policy/turn-metadata-policy.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { NativeStoredSessionConfig } from "./turn-runner-types.ts";
import type { ConversationPromptContextPlan } from "../../../context/conversation-context.ts";

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
  userText: string;
  decisionInstructions: string;
  conversationContextPlan: ConversationPromptContextPlan;
  activePersona?: string;
  personalizationProfile?: string;
  runtimePolicy?: string;
  workstreamCapsule?: string;
  personaFallback?: string;
}): ThinFirstResponsePrompt {
  const persona = input.activePersona?.trim() ||
    ["## Active Persona Reminder", input.personaFallback?.trim() ?? ""].filter(Boolean).join("\n");
  const personalizationProfile = input.personalizationProfile?.trim() ?? "";
  const recentConversation = input.conversationContextPlan.rendered;
  const runtimePolicy = input.runtimePolicy?.trim() ?? "";
  const workstreamCapsule = input.workstreamCapsule?.trim() ?? "";
  const currentRequest = ["## Current User Request", input.userText.trim()].join("\n");
  const parts = [
    input.decisionInstructions,
    persona,
    personalizationProfile,
    recentConversation,
    runtimePolicy,
    workstreamCapsule,
    currentRequest,
  ].filter((part) => part.trim());
  return {
    prompt: parts.join("\n\n"),
    promptSections: promptSections([
      ["thin_first_response_instructions", input.decisionInstructions],
      ["active_persona_reminder", persona],
      ["personalization_profile", personalizationProfile],
      ["recent_conversation", recentConversation],
      ["runtime_policy", runtimePolicy],
      ["thin_workstream_capsule", workstreamCapsule],
      ["inbound_message", currentRequest],
    ]),
  };
}

function promptSections(sections: Array<[id: string, content: string]>): PromptUsageSectionAttribution[] {
  return sections
    .filter(([, content]) => content.trim().length > 0)
    .map(([id, content]) => ({ id, chars: content.length, estimatedTokens: estimateContextTokens(content) }));
}

function hasSchedulerContinuation(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return Boolean(record.schedulerContinuation && typeof record.schedulerContinuation === "object");
}

function hasExplicitRequiredTools(metadata: unknown): boolean {
  return [
    metadataPolicyValue(metadata, "requiredNativeTools"),
    metadataPolicyValue(metadata, "required_tools"),
  ].some((value) => Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim()));
}
