export type ConversationRole = "system" | "developer" | "user" | "assistant" | "tool";
export type ConversationVisibility = "model" | "user" | "operator" | "audit_link";
export type ConversationStatus = "pending" | "complete" | "failed" | "compacted";
export type ConversationProvenance = "trusted" | "recovered" | "imported" | "synthetic_summary";
export type ConversationPartKind = "text" | "attachment_ref" | "tool_call" | "tool_result" | "summary_ref";
export type ConversationProviderShape = "openai" | "anthropic" | "generic" | null;

export interface ConversationSession {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  gateway_origin: string;
  created_at: string;
  updated_at: string;
  status: "active" | "archived" | "deleted";
  schema_version: number;
}

export interface ConversationBinding {
  gateway: string;
  external_session_id: string;
  conversation_session_id: string;
  created_at: string;
}

export interface ConversationTurn {
  id: string;
  session_id: string;
  seq: number;
  actor: "user" | "assistant" | "system";
  status: "accepted" | "running" | "complete" | "aborted" | "failed";
  request_id: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ConversationMessage {
  id: string;
  session_id: string;
  turn_id: string | null;
  seq: number;
  role: ConversationRole;
  status: ConversationStatus;
  visibility: ConversationVisibility;
  provenance: ConversationProvenance;
  created_at: string;
  compacted_by_summary_id: string | null;
  source_gateway: string | null;
  source_ref: string | null;
}

export interface ConversationPart {
  id: string;
  message_id: string;
  part_index: number;
  kind: ConversationPartKind;
  content_json: unknown;
  tool_call_id: string | null;
  parent_tool_call_id: string | null;
  provider_shape: ConversationProviderShape;
  status: ConversationStatus;
}

export interface ConversationSummary {
  id: string;
  session_id: string;
  covers_from_seq: number;
  covers_to_seq: number;
  source_hash: string;
  model: string | null;
  summary_text: string;
  created_at: string;
  invalidated_at: string | null;
}

export type TurnOutcomeKind = "delivered" | "failed" | "cancelled" | "recoverable";

export interface TurnOutcomeCapsule {
  id: string;
  session_id: string;
  turn_id: string;
  generation: number;
  outcome: TurnOutcomeKind;
  source_hash: string;
  request_message_id: string | null;
  public_assistant_message_id: string | null;
  provider_id: string | null;
  model_ref: string | null;
  evidence_refs: string[];
  unresolved_obligations: string[];
  continuation: Record<string, unknown> | null;
  safe_code: string | null;
  created_at: string;
}

export interface TurnOutcomeCapsuleInput {
  id?: string;
  sessionId: string;
  turnId: string;
  generation: number;
  outcome: TurnOutcomeKind;
  requestMessageId?: string | null;
  publicAssistantMessageId?: string | null;
  providerId?: string | null;
  modelRef?: string | null;
  evidenceRefs?: string[];
  unresolvedObligations?: string[];
  continuation?: Record<string, unknown> | null;
  safeCode?: string | null;
  createdAt?: string;
}

export interface ConversationMessageWithParts extends ConversationMessage {
  parts: ConversationPart[];
}

export interface ConversationProjectionEvent {
  outbox_id: string;
  conversation_session_id: string;
  seq: number;
  kind:
    | "conversation.session_bound"
    | "conversation.turn_started"
    | "conversation.message_committed"
    | "conversation.tool_call_committed"
    | "conversation.tool_result_committed"
    | "conversation.summary_written"
    | "conversation.turn_outcome_written"
    | "conversation.message_compacted"
    | "conversation.redacted";
  payload_ref: string;
  created_at: string;
}

export interface PromptMaterial {
  session_id: string;
  summaries: ConversationSummary[];
  semantic_tail: ConversationMessageWithParts[];
  current_turn: ConversationMessageWithParts[];
  turns?: ConversationTurn[];
  outcomes?: TurnOutcomeCapsule[];
  token_estimate: number;
  provenance: Array<{ kind: "summary" | "message"; id: string }>;
}

export interface BeginTurnInput {
  gateway: string;
  externalSessionId: string;
  sessionId?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  actor: ConversationTurn["actor"];
  requestId?: string | null;
  turnId?: string;
  now?: string;
}

export interface AppendMessageInput {
  sessionId: string;
  turnId?: string | null;
  text: string;
  messageId?: string;
  role?: ConversationRole;
  status?: ConversationStatus;
  visibility?: ConversationVisibility;
  provenance?: ConversationProvenance;
  sourceGateway?: string | null;
  sourceRef?: string | null;
  now?: string;
  parts?: Array<{
    kind: ConversationPartKind;
    contentJson: unknown;
    toolCallId?: string | null;
    parentToolCallId?: string | null;
    providerShape?: ConversationProviderShape;
    status?: ConversationStatus;
  }>;
}

export interface AppendToolPartInput {
  messageId: string;
  contentJson: unknown;
  toolCallId: string;
  parentToolCallId?: string | null;
  providerShape?: ConversationProviderShape;
  status?: ConversationStatus;
}

export interface FinalizeTurnInput {
  turnId: string;
  status?: ConversationTurn["status"];
  completedAt?: string;
  outcomeCapsule?: TurnOutcomeCapsuleInput;
}

export interface ConversationSummaryInput {
  sessionId: string;
  coversFromSeq: number;
  coversToSeq: number;
  sourceHash: string;
  summaryText: string;
  model?: string | null;
  summaryId?: string;
  now?: string;
}

export interface ReadAroundInput {
  sessionId: string;
  anchorMessageId?: string | null;
  direction?: "before" | "after" | "around";
  limit?: number;
  includeCompacted?: boolean;
}

export interface ReadMessagesInput {
  sessionId: string;
  limit?: number;
  includeCompacted?: boolean;
}

export interface ReadCognitionMessagesInput {
  sessionId?: string | null;
  roles?: ConversationRole[];
  since?: string | null;
  limit?: number;
  offset?: number;
  includeCompacted?: boolean;
  order?: "asc" | "desc";
}

export interface PromptMaterialInput {
  sessionId: string;
  tailLimit?: number;
}

export interface ConversationWriter {
  beginTurn(input: BeginTurnInput): ConversationTurn;
  appendUserMessage(input: Omit<AppendMessageInput, "role">): ConversationMessageWithParts;
  appendAssistantMessage(input: Omit<AppendMessageInput, "role">): ConversationMessageWithParts;
  appendToolCall(input: AppendToolPartInput): ConversationPart;
  appendToolResult(input: AppendToolPartInput): ConversationPart;
  finalizeTurn(input: FinalizeTurnInput): ConversationTurn;
  readTurnOutcome?(turnId: string): TurnOutcomeCapsule | null;
  writeTurnOutcome?(input: TurnOutcomeCapsuleInput): TurnOutcomeCapsule;
  writeSummary(input: ConversationSummaryInput): ConversationSummary;
  getSessionByGatewayBinding(gateway: string, externalSessionId: string): ConversationSession | null;
  readMessageBySourceRef?(
    sessionId: string,
    sourceRef: string,
  ): ConversationMessageWithParts | null;
}

export interface ConversationProjectionReader {
  readProjectionBatch(afterOutboxId: string | null, limit?: number): ConversationProjectionEvent[];
  getSession(sessionId: string): ConversationSession | null;
  getGatewayBindingForConversation(sessionId: string, gateway: string): ConversationBinding | null;
  readMessageById(messageId: string): ConversationMessageWithParts | null;
  readProjectionMessages(
    sessionId: string,
    input?: { afterSeq?: number; limit?: number },
  ): ConversationMessageWithParts[];
}

export interface ConversationContextStoreReader {
  getSession(sessionId: string): ConversationSession | null;
  getSessionByGatewayBinding(gateway: string, externalSessionId: string): ConversationSession | null;
  readMessageById(messageId: string): ConversationMessageWithParts | null;
  readMessageBySourceRef(sessionId: string, sourceRef: string): ConversationMessageWithParts | null;
  readMessages(input: ReadMessagesInput): ConversationMessageWithParts[];
  readMessagesAround(input: ReadAroundInput): ConversationMessageWithParts[];
  readSummaries(sessionId: string): ConversationSummary[];
  readTurnOutcome(turnId: string): TurnOutcomeCapsule | null;
  readPromptMaterial(input: PromptMaterialInput): PromptMaterial;
}
