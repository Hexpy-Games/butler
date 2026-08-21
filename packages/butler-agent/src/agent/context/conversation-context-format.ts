import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  ConversationMessageWithParts,
  ConversationPart,
  ConversationSummary,
  ConversationTurn,
  PromptMaterial,
  TurnOutcomeCapsule,
} from "../conversation/types.ts";

export interface ConversationContextPart {
  kind: ConversationPart["kind"];
  text: string | null;
  tool_call_id: string | null;
  parent_tool_call_id: string | null;
  provider_shape: ConversationPart["provider_shape"];
  status: ConversationPart["status"];
}

export interface ConversationContextMessage {
  conversation_message_id: string;
  turn_id: string | null;
  seq: number;
  created_at: string;
  speaker: "system" | "developer" | "user" | "butler" | "tool";
  role: ConversationMessageWithParts["role"];
  text: string;
  parts: ConversationContextPart[];
}

export interface ConversationContextSummary {
  summary_id: string;
  covers_from_seq: number;
  covers_to_seq: number;
  source_hash: string;
  text: string;
}

export interface PromptMaterialRenderOptions {
  maxTokens: number;
  excludeSourceRef?: string | null;
  excludeTurnId?: string | null;
  includeSummaries?: boolean;
  includeTools?: boolean;
  currentRequest?: {
    id: string;
    text: string;
  };
}

export interface ConversationCurrentRequestAtom {
  id: string;
  source_hash: string;
  serialized_tokens: number;
  text: string;
}

export interface ConversationSemanticTurnAtom {
  id: string;
  turn_id: string | null;
  status: ConversationTurn["status"] | "unknown";
  source_hash: string;
  first_seq: number;
  last_seq: number;
  serialized_tokens: number;
  messages: ConversationContextMessage[];
  outcome: TurnOutcomeCapsule | null;
}

export interface ConversationSummaryAtom extends ConversationContextSummary {
  id: string;
  serialized_tokens: number;
}

export interface ConversationPromptContextPlan {
  session_id: string;
  measurement: "serialized_utf8_upper_bound";
  capacity_tokens: number;
  current_request: ConversationCurrentRequestAtom | null;
  required_turns: ConversationSemanticTurnAtom[];
  optional_turns: ConversationSemanticTurnAtom[];
  selected_optional_turns: ConversationSemanticTurnAtom[];
  selected_summaries: ConversationSummaryAtom[];
  selected_atom_ids: string[];
  compiled_input_tokens: number;
  rendered: string;
}

// Preserve a bounded run of complete user-Butler pairs so short corrections
// and promise-like acknowledgements cannot evict the result they refer to.
const REQUIRED_RECENT_SEMANTIC_TURNS = 8;

export function emptyConversationPromptContextPlan(
  sessionId: string,
  capacityTokens: number,
): ConversationPromptContextPlan {
  return {
    session_id: sessionId,
    measurement: "serialized_utf8_upper_bound",
    capacity_tokens: Math.max(1, Math.floor(capacityTokens)),
    current_request: null,
    required_turns: [],
    optional_turns: [],
    selected_optional_turns: [],
    selected_summaries: [],
    selected_atom_ids: [],
    compiled_input_tokens: 0,
    rendered: "",
  };
}

export function renderPromptMaterial(
  material: PromptMaterial,
  options: PromptMaterialRenderOptions,
): string {
  return compilePromptMaterialContextPlan(material, options).rendered;
}

export function compilePromptMaterialContextPlan(
  material: PromptMaterial,
  options: PromptMaterialRenderOptions,
): ConversationPromptContextPlan {
  const capacityTokens = Math.max(1, Math.floor(options.maxTokens));
  const currentRequest = options.currentRequest ? currentRequestAtom(options.currentRequest) : null;
  const messages = material.semantic_tail
    .filter((message) => !options.excludeSourceRef || message.source_ref !== options.excludeSourceRef)
    .filter((message) =>
      !options.excludeTurnId ||
      message.turn_id !== options.excludeTurnId,
    );
  const turns = semanticTurnAtoms(
    messages,
    material.turns ?? [],
    material.outcomes ?? [],
    options.includeTools !== false,
  );
  const requiredTurns = turns.slice(-REQUIRED_RECENT_SEMANTIC_TURNS);
  const optionalTurns = turns.slice(0, -requiredTurns.length).reverse();
  const header = "## Recent Conversation";
  let used = serializedUpperBound(header);
  for (const turn of requiredTurns) used += turn.serialized_tokens;

  const selectedOptionalNewestFirst: ConversationSemanticTurnAtom[] = [];
  for (const turn of optionalTurns) {
    if (used + turn.serialized_tokens > capacityTokens) break;
    selectedOptionalNewestFirst.push(turn);
    used += turn.serialized_tokens;
  }

  const selectedSummariesNewestFirst: ConversationSummaryAtom[] = [];
  if (options.includeSummaries !== false) {
    const summaries = material.summaries.map(summaryAtom).reverse();
    for (const summary of summaries) {
      if (used + summary.serialized_tokens > capacityTokens) break;
      selectedSummariesNewestFirst.push(summary);
      used += summary.serialized_tokens;
    }
  }

  const selectedOptionalTurns = selectedOptionalNewestFirst;
  const selectedSummaries = selectedSummariesNewestFirst.reverse();
  const renderedTurns = [...selectedOptionalTurns].reverse().concat(requiredTurns);
  const body = [
    ...selectedSummaries.map(renderSummaryAtom),
    ...renderedTurns.flatMap(renderSemanticTurnAtom),
  ].filter((line) => line.trim());
  const rendered = body.length > 0 ? [header, ...body].join("\n") : "";
  return {
    session_id: material.session_id,
    measurement: "serialized_utf8_upper_bound",
    capacity_tokens: capacityTokens,
    current_request: currentRequest,
    required_turns: requiredTurns,
    optional_turns: optionalTurns,
    selected_optional_turns: selectedOptionalTurns,
    selected_summaries: selectedSummaries,
    selected_atom_ids: [
      ...(currentRequest ? [currentRequest.id] : []),
      ...selectedSummaries.map((summary) => summary.id),
      ...renderedTurns.map((turn) => turn.id),
    ],
    compiled_input_tokens: rendered ? serializedUpperBound(rendered) : 0,
    rendered,
  };
}

function currentRequestAtom(input: {
  id: string;
  text: string;
}): ConversationCurrentRequestAtom {
  return {
    id: `current_request:${input.id}`,
    source_hash: stringSourceHash(input.text),
    serialized_tokens: serializedUpperBound(input.text),
    text: input.text,
  };
}

export function toContextMessage(
  message: ConversationMessageWithParts,
  includeTools: boolean,
): ConversationContextMessage {
  const parts = message.parts
    .filter((part) => includeTools || (part.kind !== "tool_call" && part.kind !== "tool_result"))
    .map(toContextPart);
  return {
    conversation_message_id: message.id,
    turn_id: message.turn_id,
    seq: message.seq,
    created_at: message.created_at,
    speaker: speakerForRole(message.role),
    role: message.role,
    text: textForParts(parts),
    parts,
  };
}

export function toContextSummary(summary: ConversationSummary): ConversationContextSummary {
  return {
    summary_id: summary.id,
    covers_from_seq: summary.covers_from_seq,
    covers_to_seq: summary.covers_to_seq,
    source_hash: summary.source_hash,
    text: summary.summary_text,
  };
}

export function textForMessage(message: ConversationMessageWithParts, includeTools: boolean): string {
  return textForParts(
    message.parts
      .filter((part) => includeTools || (part.kind !== "tool_call" && part.kind !== "tool_result"))
      .map(toContextPart),
  );
}

function semanticTurnAtoms(
  messages: ConversationMessageWithParts[],
  turns: ConversationTurn[],
  outcomes: TurnOutcomeCapsule[],
  includeTools: boolean,
): ConversationSemanticTurnAtom[] {
  const statusByTurnId = new Map(turns.map((turn) => [turn.id, turn.status]));
  const outcomeByTurnId = new Map(outcomes.map((outcome) => [outcome.turn_id, outcome]));
  const grouped = new Map<string, ConversationMessageWithParts[]>();
  for (const message of messages) {
    const key = message.turn_id ? `turn:${message.turn_id}` : `message:${message.id}`;
    const group = grouped.get(key) ?? [];
    group.push(message);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const turnId = first.turn_id;
    const id = turnId ? `conversation_turn:${turnId}` : `conversation_message:${first.id}`;
    const contextMessages = group.map((message) => toContextMessage(message, includeTools));
    const outcome = turnId ? outcomeByTurnId.get(turnId) ?? null : null;
    const rendered = renderSemanticTurnMessages({
      id,
      turnId,
      status: turnId ? statusByTurnId.get(turnId) ?? "unknown" : "unknown",
      messages: contextMessages,
      outcome,
    });
    return {
      id,
      turn_id: turnId,
      status: turnId ? statusByTurnId.get(turnId) ?? "unknown" : "unknown",
      source_hash: sourceHash(group),
      first_seq: first.seq,
      last_seq: last.seq,
      serialized_tokens: serializedUpperBound(rendered.join("\n")),
      messages: contextMessages,
      outcome,
    };
  });
}

function summaryAtom(summary: ConversationSummary): ConversationSummaryAtom {
  const context = toContextSummary(summary);
  const atom = {
    ...context,
    id: `conversation_summary:${summary.id}`,
    serialized_tokens: 0,
  };
  atom.serialized_tokens = serializedUpperBound(renderSummaryAtom(atom));
  return atom;
}

function renderSummaryAtom(summary: ConversationSummaryAtom): string {
  return `summary ${summary.summary_id} seq ${summary.covers_from_seq}-${summary.covers_to_seq}: ${summary.text.trim()}`;
}

function renderSemanticTurnAtom(turn: ConversationSemanticTurnAtom): string[] {
  return renderSemanticTurnMessages({
    id: turn.id,
    turnId: turn.turn_id,
    status: turn.status,
    messages: turn.messages,
    outcome: turn.outcome,
  });
}

function renderSemanticTurnMessages(input: {
  id: string;
  turnId: string | null;
  status: ConversationSemanticTurnAtom["status"];
  messages: ConversationContextMessage[];
  outcome: TurnOutcomeCapsule | null;
}): string[] {
  return [
    `turn ${input.turnId ?? input.id} status ${input.status}`,
    ...(input.outcome ? [renderOutcomeCapsule(input.outcome)] : []),
    ...input.messages.flatMap((message) =>
      message.text.trim() ? [`${message.speaker}: ${message.text}`] : [],
    ),
  ];
}

function renderOutcomeCapsule(outcome: TurnOutcomeCapsule): string {
  return `outcome ${outcome.outcome} generation ${outcome.generation}: ${JSON.stringify({
    source_hash: outcome.source_hash,
    request_message_id: outcome.request_message_id,
    public_assistant_message_id: outcome.public_assistant_message_id,
    evidence_refs: outcome.evidence_refs,
    unresolved_obligations: outcome.unresolved_obligations,
    continuation: outcome.continuation,
    safe_code: outcome.safe_code,
  })}`;
}

function sourceHash(messages: ConversationMessageWithParts[]): string {
  const payload = messages.map((message) => ({
    id: message.id,
    turn_id: message.turn_id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    parts: message.parts.map((part) => ({
      id: part.id,
      kind: part.kind,
      content_json: part.content_json,
      tool_call_id: part.tool_call_id,
      parent_tool_call_id: part.parent_tool_call_id,
      status: part.status,
    })),
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function stringSourceHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function serializedUpperBound(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function speakerForRole(role: ConversationMessageWithParts["role"]): ConversationContextMessage["speaker"] {
  if (role === "assistant") return "butler";
  if (role === "developer") return "developer";
  if (role === "system") return "system";
  if (role === "tool") return "tool";
  return "user";
}

function toContextPart(part: ConversationPart): ConversationContextPart {
  return {
    kind: part.kind,
    text: textForPart(part),
    tool_call_id: part.tool_call_id,
    parent_tool_call_id: part.parent_tool_call_id,
    provider_shape: part.provider_shape,
    status: part.status,
  };
}

function textForParts(parts: ConversationContextPart[]): string {
  return parts
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function textForPart(part: ConversationPart): string | null {
  const content = part.content_json;
  if (part.kind === "text") return objectString(content, "text");
  if (part.kind === "attachment_ref") {
    const fileName = objectString(content, "fileName") ?? objectString(content, "filename");
    const id = objectString(content, "id");
    return `[attachment:${[fileName, id].filter(Boolean).join(":") || "ref"}]`;
  }
  if (part.kind === "summary_ref") return objectString(content, "summary_id") ?? "[summary_ref]";
  if (part.kind === "tool_call") {
    const name = objectString(content, "safeToolName") ?? objectString(content, "toolName") ??
      objectString(content, "name") ?? "tool";
    return `[tool_call:${name}:${part.tool_call_id ?? "unknown"}]`;
  }
  if (part.kind === "tool_result") {
    const ok = objectBoolean(content, "ok");
    const label = objectString(content, "safeLabel") ?? objectString(content, "status") ?? (ok === false ? "failed" : "complete");
    return `[tool_result:${label}:${part.parent_tool_call_id ?? part.tool_call_id ?? "unknown"}]`;
  }
  return null;
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function objectBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "boolean" ? raw : null;
}
