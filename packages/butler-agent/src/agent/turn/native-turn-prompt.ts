import type {
  AttachmentRef,
  InboundEnvelope,
  RuntimeTurnInput,
} from "../../test-support/harness/contracts.ts";
import {
  readTranscript,
  type TranscriptEvent,
} from "../../test-support/harness/transcripts.ts";
import { renderAttachmentContext } from "../context/attachment-context.ts";
import { takeLinesFromEndWithinBudget } from "../context/budget.ts";

export interface NormalizedTurnPrompt {
  prompt: string;
  promptContextChars: number;
  compactionContextChars: number;
  feedbackBufferContextChars: number;
  workingMemoryContextChars: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
}

export function currentInboundEventId(input: RuntimeTurnInput): string | null {
  if ("text" in input.input) return null;
  return input.input.eventId;
}

export function currentRuntimeTurnId(input: RuntimeTurnInput): string | null {
  const metadata = input.metadata && typeof input.metadata === "object"
    ? input.metadata as Record<string, unknown>
    : {};
  return typeof metadata.turnId === "string" && metadata.turnId.trim()
    ? metadata.turnId.trim()
    : currentInboundEventId(input);
}

export function currentUserText(input: RuntimeTurnInput): string {
  return metadataCurrentUserText(input) || inboundText(input);
}

export function inboundAttachments(input: RuntimeTurnInput): AttachmentRef[] {
  if ("text" in input.input) return [];
  return Array.isArray(input.input.message.attachments)
    ? input.input.message.attachments
    : [];
}

export function promptContextIncludesSection(input: RuntimeTurnInput, title: string): boolean {
  const promptContext =
    typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext : "";
  return promptContext.includes(`## ${title}`);
}

export function promptContextSection(prompt: string, title: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  const section = new RegExp(
    `(?:^|\\n)(## ${escapeRegExp(title)}\\n[\\s\\S]*?)(?=\\n## |\\n---\\n|$)`,
    "u",
  ).exec(trimmed)?.[1];
  return section?.trim() ?? "";
}

export function stableJsonForCache(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ));
}

export function normalizeTurnPrompt(input: RuntimeTurnInput, options: {
  recallContext?: string;
  compactionContext?: string;
  feedbackBufferContext?: string;
  workingMemoryContext?: string;
  runtimePolicyContext?: string;
  recentConversationTokenBudget: number;
  butlerData: string;
}): NormalizedTurnPrompt {
  const parts: string[] = [];
  const rawPromptContext =
    typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext.trim() : "";
  const structuredCurrentText = metadataCurrentUserText(input);
  const promptContext = structuredCurrentText
    ? removePromptContextSection(rawPromptContext, "Current User Input")
    : rawPromptContext;
  if (promptContext) parts.push(promptContext);

  const compactionContext = options.compactionContext?.trim() ?? "";
  if (compactionContext) parts.push(compactionContext);

  const feedbackBufferContext = options.feedbackBufferContext?.trim() ?? "";
  if (feedbackBufferContext) parts.push(feedbackBufferContext);

  const workingMemoryContext = options.workingMemoryContext?.trim() ?? "";
  if (workingMemoryContext) parts.push(workingMemoryContext);

  const recentConversation = buildRecentConversation(
    input,
    options.recentConversationTokenBudget,
    options.butlerData,
  );
  if (recentConversation) parts.push(recentConversation);

  const recallContext = options.recallContext?.trim() ?? "";
  if (recallContext) parts.push(recallContext);

  const runtimePolicyContext = options.runtimePolicyContext?.trim() ?? "";
  if (runtimePolicyContext) parts.push(runtimePolicyContext);

  let inboundMessageChars: number;
  const promptContextHasCurrentInput = promptContextIncludesSection(input, "Current User Input");
  if ("text" in input.input) {
    const text = structuredCurrentText || input.input.text?.trim() || "";
    inboundMessageChars = text.length;
    if (structuredCurrentText || !promptContextHasCurrentInput) {
      parts.push("## Inbound Message");
      parts.push(`Message Text: ${text}`);
    }
  } else {
    const envelope = input.input as InboundEnvelope;
    const text = structuredCurrentText || envelope.message.text?.trim() || "";
    inboundMessageChars = text.length;
    if (structuredCurrentText || !promptContextHasCurrentInput) {
      parts.push("## Inbound Message");
      parts.push(`Transport: ${envelope.transport}`);
      parts.push(`Sender ID: ${envelope.sender.id}`);
      if (envelope.sender.displayName) parts.push(`Sender Name: ${envelope.sender.displayName}`);
      parts.push(`Message ID: ${envelope.message.id}`);
      parts.push(`Message Timestamp: ${envelope.message.timestamp}`);
      parts.push(`Message Text: ${text}`);
    }
  }

  const prompt = parts.filter(Boolean).join("\n");
  return {
    prompt,
    promptContextChars: promptContext.length,
    compactionContextChars: compactionContext.length,
    feedbackBufferContextChars: feedbackBufferContext.length,
    workingMemoryContextChars: workingMemoryContext.length,
    recentConversationChars: recentConversation.length,
    recallContextChars: recallContext.length,
    inboundMessageChars,
  };
}

function transcriptLines(event: TranscriptEvent, butlerData: string): string[] {
  const payload = event.payload as Record<string, any>;
  const message = payload.message as Record<string, any> | undefined;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentContext = renderAttachmentContext(attachments, {
    butlerData,
    title: event.kind === "inbound" ? "User Attachments" : "Butler Attachments",
    includeTextContent: false,
  });
  if (event.kind === "inbound") {
    const text = message?.text;
    return [
      typeof text === "string" && text.trim() ? `user: ${text.trim()}` : "",
      attachmentContext,
    ].filter((line) => line.trim());
  }
  if (event.kind === "outbound") {
    const text = message?.text;
    return [
      typeof text === "string" && text.trim() ? `butler: ${text.trim()}` : "",
      attachmentContext,
    ].filter((line) => line.trim());
  }
  return [];
}

function buildRecentConversation(input: RuntimeTurnInput, maxTokens: number, butlerData: string): string {
  const currentEventId = currentInboundEventId(input);
  const lines = readTranscript(input.handle.sessionId)
    .filter((event) =>
      event.eventId !== currentEventId &&
      (event.payload as Record<string, any>)?.eventId !== currentEventId)
    .flatMap((event) => transcriptLines(event, butlerData))
    .filter((line) => line.trim());

  const selected = takeLinesFromEndWithinBudget(lines, maxTokens);
  if (selected.length === 0) return "";
  return ["## Recent Conversation", ...selected].join("\n");
}

function removePromptContextSection(promptContext: string, title: string): string {
  if (!promptContext.trim()) return "";
  const section = new RegExp(`(?:^|\\n)## ${escapeRegExp(title)}\\n[\\s\\S]*?(?=\\n## |$)`, "u");
  return promptContext.replace(section, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inboundText(input: RuntimeTurnInput): string {
  if ("text" in input.input) return input.input.text?.trim() || "";
  return input.input.message.text?.trim() || "";
}

function metadataCurrentUserText(input: RuntimeTurnInput): string {
  return typeof input.metadata?.currentUserText === "string"
    ? input.metadata.currentUserText.trim()
    : "";
}
