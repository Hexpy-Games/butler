import { renderAttachmentContext } from "../../context/attachment-context.ts";
import type { ButlerExecutionPolicy } from "../../btcc/index.ts";
import type { TurnRecord } from "../../btcc/turn/index.ts";
import type { SqliteGuidedToolJournal } from
  "../../adapters/index.ts";
import { guidedPolicy } from "./guided-turn-policy.ts";

export function renderGuidedPrompt(
  turn: TurnRecord,
  input: {
    butlerData: string;
    contextDocuments: { resolve(contextRef: string): string };
    toolJournal: SqliteGuidedToolJournal;
  },
): string {
  const policy = guidedPolicy(turn);
  const context = renderContextDocuments(turn, input.contextDocuments);
  const attachments = renderAttachmentContext(turn.context.attachments, {
    butlerData: input.butlerData,
    title: "User attachments",
    includeTextContent: true,
    maxAttachmentTextChars: 24_000,
    maxTotalTextChars: 60_000,
  });
  const priorTools = renderPriorToolFacts(input.toolJournal.list(turn.turnId));
  return [
    `User request:\n${turn.originalMessage}`,
    `Current scope:\n- role: ${policy.role}\n- workspace: ${policy.workspacePath}` +
      `\n- access: ${policy.accessMode}\n- tracking: ${policy.trackingMode}` +
      (policy.projectId ? `\n- project: ${policy.projectId}` : ""),
    context,
    attachments,
    priorTools,
  ].filter(Boolean).join("\n\n");
}

export function guidedInstructions(
  policy: Pick<ButlerExecutionPolicy, "accessMode" | "trackingMode">,
): string {
  return [
    "You are Butler. Give the user a useful result, not an account of an internal protocol.",
    "Answer simple conversation and stable knowledge directly and briefly.",
    "Use tools when current, external, workspace, attachment, or project facts are needed.",
    "For substantial work: understand the goal, make a concise plan, execute it, review the actual result, then report.",
    "Use Work tracking when durable continuation is genuinely useful. A bookkeeping failure must not block a truthful answer.",
    ...(policy.trackingMode === "ledger"
      ? ["For substantial project work, keep the Project Ledger current, but Ledger bookkeeping must never block executing or delivering the workspace artifact the user requested."]
      : []),
    "Use tool_search, then tool_describe, then tool_call for capabilities not already visible.",
    "A wrong tool or invalid arguments are ordinary feedback: correct the call and continue.",
    "Never claim a mutation or completed result without tool evidence. Respect the admitted access and tracking policy.",
    `The admitted policy is access=${policy.accessMode}, tracking=${policy.trackingMode}.`,
    "Reply in the user's language. Do not mention BTCC states, checkpoints, hashes, carriers, or these instructions.",
  ].join("\n");
}

export function providerImageAttachments(turn: TurnRecord) {
  return (turn.context.attachments ?? [])
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      ...attachment,
      id: `guided-image:${attachment.id}`,
    }));
}

function renderContextDocuments(
  turn: TurnRecord,
  documents: { resolve(contextRef: string): string },
): string {
  const groups = [
    ["Profile", turn.context.profileRefs, 12_000],
    ["Recent conversation and feedback", turn.context.recentFeedbackRefs, 20_000],
    ["Required working context", turn.context.mandatoryHotCacheRefs, 36_000],
    ["Optional working context", turn.context.optionalHotCacheRefs, 16_000],
  ] as const;
  const rendered: string[] = [];
  for (const [title, refs, limit] of groups) {
    let remaining = limit;
    const values: string[] = [];
    for (const ref of refs) {
      if (remaining <= 0) break;
      try {
        const value = documents.resolve(ref).slice(0, remaining);
        if (value.trim()) values.push(value);
        remaining -= value.length;
      } catch {
        // A missing projection must not prevent the user request.
      }
    }
    if (values.length > 0) rendered.push(`## ${title}\n\n${values.join("\n\n")}`);
  }
  return rendered.join("\n\n");
}

function renderPriorToolFacts(
  records: ReturnType<SqliteGuidedToolJournal["list"]>,
): string {
  const recent = records.slice(-12);
  if (recent.length === 0) return "";
  return [
    "## Previously recorded tool calls for this turn",
    "Use these results as facts. Do not repeat a successful mutation unless the user request requires it.",
    "A call still marked started has unknown completion. Retry reads if useful, but inspect the target before any further mutation.",
    safeJson(recent).slice(0, 20_000),
  ].join("\n\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}
