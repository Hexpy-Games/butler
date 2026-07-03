import type {
  AttachmentRef,
  InboundEnvelope,
  RuntimeTurnInput,
} from "../../../../test-support/harness/contracts.ts";
import {
  canonicalConversationSessionId,
  renderPromptMaterial,
  withConversationReader,
  type ConversationContextReader,
} from "../../../context/conversation-context.ts";
import {
  createTurnContextAtomId,
  readTurnContextAtom,
  type TurnContextAtom,
} from "../../turn-continuation-context.ts";

export interface NormalizedTurnPrompt {
  prompt: string;
  promptContextChars: number;
  compactionContextChars: number;
  feedbackBufferContextChars: number;
  workingMemoryContextChars: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
  focusedResumeEnvelopeChars: number;
  resumeDecisionEnvelopeChars: number;
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
  focusedResumeEnvelope?: string;
  resumeDecisionEnvelope?: string;
  removePromptContextSections?: string[];
  skipRecentConversation?: boolean;
  recentConversationTokenBudget: number;
  butlerData: string;
  conversationReader?: ConversationContextReader;
}): NormalizedTurnPrompt {
  const parts: string[] = [];
  const schedulerContinuationRequested = hasSchedulerContinuationMetadata(input);
  const schedulerAtomContext = renderSchedulerContinuationAtomContext(input, options.butlerData);
  if (schedulerAtomContext) parts.push(schedulerAtomContext);
  const rawPromptContext =
    typeof input.metadata?.promptContext === "string" ? input.metadata.promptContext.trim() : "";
  const schedulerContinuation = schedulerContinuationRequested;
  const structuredCurrentText = metadataCurrentUserText(input);
  const promptContext = structuredCurrentText
    ? removePromptContextSection(rawPromptContext, "Current User Input")
    : rawPromptContext;
  const filteredPromptContext = removePromptContextSections(
    promptContext,
    options.removePromptContextSections ?? [],
  );
  if (filteredPromptContext) parts.push(filteredPromptContext);

  const focusedResumeEnvelope = options.focusedResumeEnvelope?.trim() ?? "";
  if (focusedResumeEnvelope) parts.push(focusedResumeEnvelope);

  const resumeDecisionEnvelope = options.resumeDecisionEnvelope?.trim() ?? "";
  if (resumeDecisionEnvelope) parts.push(resumeDecisionEnvelope);

  const compactionContext = options.compactionContext?.trim() ?? "";
  if (compactionContext) parts.push(compactionContext);

  const feedbackBufferContext = options.feedbackBufferContext?.trim() ?? "";
  if (feedbackBufferContext) parts.push(feedbackBufferContext);

  const workingMemoryContext = options.workingMemoryContext?.trim() ?? "";
  if (workingMemoryContext) parts.push(workingMemoryContext);

  const recentConversation = options.skipRecentConversation === true
    ? ""
    : buildRecentConversation(
        input,
        options.recentConversationTokenBudget,
        options.butlerData,
        options.conversationReader,
      );
  if (recentConversation) parts.push(recentConversation);

  const recallContext = options.recallContext?.trim() ?? "";
  if (recallContext) parts.push(recallContext);

  const runtimePolicyContext = options.runtimePolicyContext?.trim() ?? "";
  if (runtimePolicyContext) parts.push(runtimePolicyContext);

  let inboundMessageChars: number;
  const promptContextHasCurrentInput = promptContextIncludesSection(input, "Current User Input");
  if (schedulerContinuation) {
    inboundMessageChars = 0;
  } else if ("text" in input.input) {
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
    promptContextChars: filteredPromptContext.length,
    compactionContextChars: compactionContext.length,
    feedbackBufferContextChars: feedbackBufferContext.length,
    workingMemoryContextChars: workingMemoryContext.length,
    recentConversationChars: recentConversation.length,
    recallContextChars: recallContext.length,
    inboundMessageChars,
    focusedResumeEnvelopeChars: focusedResumeEnvelope.length,
    resumeDecisionEnvelopeChars: resumeDecisionEnvelope.length,
  };
}

function renderSchedulerContinuationAtomContext(
  input: RuntimeTurnInput,
  butlerData: string,
): string {
  const metadata = input.metadata && typeof input.metadata === "object"
    ? input.metadata as Record<string, unknown>
    : {};
  const continuation = metadata.schedulerContinuation && typeof metadata.schedulerContinuation === "object"
    ? metadata.schedulerContinuation as Record<string, unknown>
    : null;
  const contextAtomId = typeof continuation?.contextAtomId === "string"
    ? continuation.contextAtomId.trim()
    : "";
  if (!contextAtomId) {
    if (!continuation) return "";
    throw schedulerContinuationInvariantFault(
      "turn_scheduler_continuation_missing_atom_id",
      "Scheduler continuation metadata did not include a context atom id.",
    );
  }
  const turnId = currentRuntimeTurnId(input);
  if (!turnId) {
    throw schedulerContinuationInvariantFault(
      "turn_scheduler_continuation_missing_turn_id",
      "Scheduler continuation metadata did not include a resolvable turn id.",
    );
  }
  const expectedContextAtomId = createTurnContextAtomId(input.handle.sessionId, turnId);
  if (contextAtomId !== expectedContextAtomId) {
    throw schedulerContinuationInvariantFault(
      "turn_scheduler_continuation_atom_mismatch",
      "Scheduler continuation metadata referenced an atom that does not match this session turn.",
    );
  }
  const atom = readTurnContextAtom({
    butlerData,
    sessionId: input.handle.sessionId,
    turnId,
  });
  if (!atom) {
    throw schedulerContinuationInvariantFault(
      "turn_scheduler_continuation_atom_unavailable",
      "Scheduler continuation context atom could not be read.",
    );
  }
  return renderTurnContextAtom(atom, contextAtomId);
}

function hasSchedulerContinuationMetadata(input: RuntimeTurnInput): boolean {
  const metadata = input.metadata && typeof input.metadata === "object"
    ? input.metadata as Record<string, unknown>
    : {};
  return Boolean(metadata.schedulerContinuation && typeof metadata.schedulerContinuation === "object");
}

function schedulerContinuationInvariantFault(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "TurnSchedulerContinuationInvariantError",
    code,
  });
}

function renderTurnContextAtom(atom: TurnContextAtom, contextAtomId: string): string {
  const lines = [
    "## Scheduler Continuation Context Atom",
    `Context Atom ID: ${contextAtomId}`,
    `Turn ID: ${atom.turnId}`,
    `State: ${atom.state}`,
    `Source Error Code: ${atom.sourceErrorCode}`,
    `Reason: ${atom.reason}`,
    `User Request Ref: ${atom.userRequest.id}`,
  ];
  if (atom.latestAssistantDecision) {
    lines.push(`Latest Assistant Decision Ref: ${atom.latestAssistantDecision.id}`);
  }
  if (atom.latestCompletionReview) {
    lines.push([
      "Latest Completion Review:",
      atom.latestCompletionReview.status,
      atom.latestCompletionReview.observationId ? `observation=${atom.latestCompletionReview.observationId}` : "",
    ].filter(Boolean).join(" "));
  }
  lines.push(renderAtomRefs("Unresolved Observations", atom.unresolvedObservations));
  lines.push(renderAtomRefs("Open Tool Pairs", atom.openToolPairs));
  lines.push(renderAtomRefs("Current Turn Work", atom.currentTurnWork));
  lines.push(renderAtomRefs("Current Turn Todos", atom.currentTurnTodos));
  lines.push("Continuation Instruction: resume this same logical turn from the context atom facts before using active WorkStream/Todo fallback.");
  return lines.filter((line) => line.trim()).join("\n");
}

function renderAtomRefs(
  title: string,
  refs: TurnContextAtom["unresolvedObservations"],
): string {
  if (refs.length === 0) return `${title}: none`;
  return [
    `${title}:`,
    ...refs.map((ref) => `- ${ref.kind}:${ref.id}${ref.path ? ` path=${ref.path}` : ""}`),
  ].join("\n");
}

function buildRecentConversation(
  input: RuntimeTurnInput,
  maxTokens: number,
  butlerData: string,
  conversationReader?: ConversationContextReader,
): string {
  return withConversationReader({
    butlerData,
    reader: conversationReader,
    fn: (reader) => {
      const canonicalSessionId = canonicalConversationSessionId({
        reader,
        runtimeSessionId: input.handle.sessionId,
        gateway: "text" in input.input ? null : input.input.transport,
      });
      return renderPromptMaterial(
        reader.readPromptMaterial({
          sessionId: canonicalSessionId,
          tailLimit: 80,
        }),
        {
          maxTokens,
          excludeSourceRef: currentInboundEventId(input),
        },
      );
    },
  });
}

function removePromptContextSection(promptContext: string, title: string): string {
  if (!promptContext.trim()) return "";
  const section = new RegExp(`(?:^|\\n)## ${escapeRegExp(title)}\\n[\\s\\S]*?(?=\\n## |$)`, "u");
  return promptContext.replace(section, "").trim();
}

function removePromptContextSections(promptContext: string, titles: string[]): string {
  return titles.reduce((current, title) => removePromptContextSection(current, title), promptContext);
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
