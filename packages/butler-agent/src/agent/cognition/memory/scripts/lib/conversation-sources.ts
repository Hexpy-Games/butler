import { existsSync } from "node:fs";
import type { TranscriptEvent } from "../../../../../test-support/harness/transcripts.ts";
import { AgentConversationStore, conversationStorePath } from "../../../../conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../../../../conversation/session-admission.ts";
import type {
  ConversationMessageWithParts,
  ConversationPart,
  ConversationProvenance,
  ConversationRole as StoreConversationRole,
} from "../../../../conversation/types.ts";
import { textForMessage } from "../../../../context/conversation-context-format.ts";

export type ConversationRole = "human" | "assistant" | "channel";
export type ConversationObservationRole = "user" | "assistant" | "system" | "tool";

export interface ConversationObservation {
  conversation_session_id: string;
  conversation_turn_id: string | null;
  conversation_message_id: string;
  role: ConversationObservationRole;
  created_at: string;
  project_id: string | null;
  workspace_id: string | null;
  text: string;
  part_refs: Array<{ kind: "attachment" | "artifact" | "tool_result" | "summary"; id: string }>;
  provenance: ConversationProvenance;
  audit_refs: string[];
}

export interface ReadConversationObservationsInput {
  butlerData: string;
  sessionId?: string | null;
  conversationTurnId?: string | null;
  roles?: ConversationObservationRole[];
  since?: string | null;
  limit?: number;
  offset?: number;
  maxMessages?: number;
  includeCompacted?: boolean;
  order?: "asc" | "desc";
}

export interface ConversationMessage {
  role: ConversationRole;
  text: string;
  timestamp: string;
}

export interface ConversationChunk {
  messages: ConversationMessage[];
  startTime: string;
  endTime: string;
}

export type ConversationLogFormat = "butler-transcript" | "unknown";

export interface ParsedConversationLog {
  format: ConversationLogFormat;
  sessionId?: string;
  messages: ConversationMessage[];
}

const THIRTY_MIN_MS = 30 * 60 * 1000;
const DEFAULT_OBSERVATION_LIMIT = 1000;

function parseJsonLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isButlerTranscriptEvent(value: any): value is TranscriptEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.eventId === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.kind === "string" &&
      typeof value.timestamp === "string" &&
      value.payload &&
      typeof value.payload === "object",
  );
}

function appendMessage(
  messages: ConversationMessage[],
  role: ConversationRole,
  text: string,
  timestamp: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role && last.text === trimmed) {
    return;
  }
  messages.push({
    role,
    text: trimmed,
    timestamp,
  });
}

function nestedText(payload: Record<string, unknown>, key: "message" | "text"): string {
  if (key === "text") {
    return typeof payload.text === "string" ? payload.text : "";
  }
  const message = payload.message;
  if (!message || typeof message !== "object") return "";
  const text = (message as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function detectConversationLogFormat(lines: string[]): ConversationLogFormat {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonLine(trimmed);
    if (!parsed) continue;
    if (isButlerTranscriptEvent(parsed)) return "butler-transcript";
  }
  return "unknown";
}

export function parseButlerTranscriptLines(lines: string[]): ParsedConversationLog {
  const messages: ConversationMessage[] = [];
  let sessionId: string | undefined;

  for (const line of lines) {
    const obj = parseJsonLine(line);
    if (!isButlerTranscriptEvent(obj)) continue;
    sessionId ??= obj.sessionId;

    if (obj.kind === "inbound") {
      const text = nestedText(obj.payload, "message");
      appendMessage(messages, "human", text, obj.timestamp);
      continue;
    }

    if (obj.kind === "outbound") {
      const text = nestedText(obj.payload, "message");
      appendMessage(messages, "assistant", text, obj.timestamp);
      continue;
    }

    if (obj.kind === "turn") {
      const text = nestedText(obj.payload, "text");
      appendMessage(messages, "assistant", text, obj.timestamp);
    }
  }

  return {
    format: "butler-transcript",
    sessionId,
    messages,
  };
}

export function parseConversationLogLines(lines: string[]): ParsedConversationLog {
  const format = detectConversationLogFormat(lines);
  if (format === "butler-transcript") {
    return parseButlerTranscriptLines(lines);
  }
  return {
    format: "unknown",
    messages: [],
  };
}

export function renderConversationText(messages: ConversationMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "butler" : "user";
      return `${role}: ${message.text}`;
    })
    .join("\n\n");
}

export function buildIndexInputFromMessages(messages: ConversationMessage[]): string {
  return messages
    .map((message) => JSON.stringify(
      message.role === "assistant"
        ? {
            type: "assistant",
            timestamp: message.timestamp,
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: message.text,
                },
              ],
            },
          }
        : {
            type: "user",
            timestamp: message.timestamp,
            message: {
              role: "user",
              content: message.text,
            },
          },
    ))
    .join("\n");
}

export function readConversationObservations(
  input: ReadConversationObservationsInput,
): ConversationObservation[] {
  if (!existsSync(conversationStorePath(input.butlerData))) return [];
  const store = new AgentConversationStore({ butlerData: input.butlerData });
  try {
    const sessionId = resolveConversationObservationSessionId(store, input.sessionId ?? null);
    const messages = input.conversationTurnId?.trim()
      ? store.readMessagesForTurn(input.conversationTurnId.trim())
      : store.readCognitionMessages({
        sessionId,
        roles: storeRolesForObservationRoles(input.roles),
        since: input.since,
        limit: input.maxMessages ?? input.limit ?? DEFAULT_OBSERVATION_LIMIT,
        offset: input.offset,
        includeCompacted: input.includeCompacted,
        order: input.order,
      });
    const roles = storeRolesForObservationRoles(input.roles);
    const sessions = new Map<string, { project_id: string | null; workspace_id: string | null }>();
    return messages
      .filter((message) => !sessionId || message.session_id === sessionId)
      .filter((message) => !roles || roles.includes(message.role))
      .map((message) => {
        let session = sessions.get(message.session_id);
        if (!session) {
          const row = store.getSession(message.session_id);
          session = {
            project_id: row?.project_id ?? null,
            workspace_id: row?.workspace_id ?? null,
          };
          sessions.set(message.session_id, session);
        }
        return observationFromMessage(message, session);
      })
      .filter((observation) => observation.text.trim());
  } finally {
    store.close();
  }
}

export function buildIndexInputFromObservations(observations: ConversationObservation[]): string {
  return observations
    .map((observation) => JSON.stringify(
      observation.role === "assistant"
        ? {
            type: "assistant",
            timestamp: observation.created_at,
            source_message_ids: [observation.conversation_message_id],
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: observation.text,
                },
              ],
            },
          }
        : {
            type: observation.role === "user" ? "user" : observation.role,
            timestamp: observation.created_at,
            source_message_ids: [observation.conversation_message_id],
            message: {
              role: observation.role,
              content: observation.text,
            },
          },
    ))
    .join("\n");
}

function resolveConversationObservationSessionId(
  store: AgentConversationStore,
  sessionId: string | null,
): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed) return undefined;
  if (store.getSession(trimmed)) return trimmed;
  const durable = conversationSessionIdForDurableSession(trimmed);
  if (store.getSession(durable)) return durable;
  return trimmed;
}

function storeRolesForObservationRoles(
  roles: ConversationObservationRole[] | undefined,
): StoreConversationRole[] | undefined {
  if (!roles || roles.length === 0) return undefined;
  const mapped = new Set<StoreConversationRole>();
  for (const role of roles) {
    if (role === "system") {
      mapped.add("system");
      mapped.add("developer");
      continue;
    }
    mapped.add(role);
  }
  return [...mapped];
}

function observationRole(role: StoreConversationRole): ConversationObservationRole {
  if (role === "developer") return "system";
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "system";
}

function observationFromMessage(
  message: ConversationMessageWithParts,
  session: { project_id: string | null; workspace_id: string | null },
): ConversationObservation {
  return {
    conversation_session_id: message.session_id,
    conversation_turn_id: message.turn_id,
    conversation_message_id: message.id,
    role: observationRole(message.role),
    created_at: message.created_at,
    project_id: session.project_id,
    workspace_id: session.workspace_id,
    text: textForMessage(message, true),
    part_refs: message.parts.flatMap(partRef),
    provenance: message.provenance,
    audit_refs: auditRefs(message),
  };
}

function partRef(part: ConversationPart): ConversationObservation["part_refs"] {
  const content = part.content_json;
  if (part.kind === "attachment_ref") {
    return [
      { kind: "attachment", id: objectString(content, "id") ?? objectString(content, "fileName") ?? part.id },
    ];
  }
  if (part.kind === "tool_result") {
    return [
      { kind: "tool_result", id: part.parent_tool_call_id ?? part.tool_call_id ?? part.id },
    ];
  }
  if (part.kind === "summary_ref") {
    return [
      { kind: "summary", id: objectString(content, "summary_id") ?? part.id },
    ];
  }
  const artifactId = objectString(content, "artifact_id") ?? objectString(content, "artifactId");
  return artifactId ? [{ kind: "artifact", id: artifactId }] : [];
}

function auditRefs(message: ConversationMessageWithParts): string[] {
  const sourceRef = message.source_ref?.trim();
  if (!sourceRef) return [];
  const refs = [sourceRef];
  if (message.source_gateway?.trim()) refs.push(`${message.source_gateway.trim()}:${sourceRef}`);
  if (sourceRef.startsWith("transcript:")) refs.push(sourceRef);
  return [...new Set(refs)];
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function chunkConversationByGap(
  messages: ConversationMessage[],
  gapMs = THIRTY_MIN_MS,
): ConversationChunk[] {
  if (messages.length === 0) return [];

  const chunks: ConversationChunk[] = [];
  let current = [messages[0]];

  for (let index = 1; index < messages.length; index += 1) {
    const prevTs = new Date(messages[index - 1].timestamp).getTime();
    const currTs = new Date(messages[index].timestamp).getTime();
    if (currTs - prevTs > gapMs) {
      chunks.push({
        messages: current,
        startTime: current[0].timestamp,
        endTime: current[current.length - 1].timestamp,
      });
      current = [messages[index]];
      continue;
    }
    current.push(messages[index]);
  }

  chunks.push({
    messages: current,
    startTime: current[0].timestamp,
    endTime: current[current.length - 1].timestamp,
  });
  return chunks;
}
