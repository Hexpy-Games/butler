import type { RuntimeTurnEventInput, StoredSessionBinding } from "../../test-support/harness/contracts.ts";
import type { InboundEnvelope } from "../../gateways/core/contracts.ts";
import {
  classifyForConversation,
  type AdmissionDecision,
  type ConversationAdmissionInput,
} from "./admission.ts";
import { recordConversationAdmissionMetric } from "./admission-metrics.ts";
import type {
  ConversationMessageWithParts,
  ConversationTurn,
  ConversationWriter,
} from "./types.ts";

export interface ConversationAdmissionTurnInput {
  writer: ConversationWriter;
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  turnId: string;
  timestamp: string;
  butlerData?: string;
}

export class ConversationAdmissionTurn {
  private readonly knownToolCallIds = new Set<string>();
  private toolMessage: ConversationMessageWithParts | null = null;

  private constructor(
    private readonly input: ConversationAdmissionTurnInput,
    private readonly turn: ConversationTurn,
  ) {}

  static begin(input: ConversationAdmissionTurnInput): ConversationAdmissionTurn {
    const existing = input.writer.getSessionByGatewayBinding(
      input.envelope.transport,
      input.binding.sessionId,
    );
    const turn = input.writer.beginTurn({
      gateway: input.envelope.transport,
      externalSessionId: input.binding.sessionId,
      sessionId: existing?.id,
      workspaceId: null,
      projectId: input.binding.projectId ?? null,
      actor: "user",
      requestId: input.envelope.eventId,
      turnId: input.turnId,
      now: input.timestamp,
    });
    return new ConversationAdmissionTurn(input, turn);
  }

  admitInbound(): void {
    const event: ConversationAdmissionInput = {
      source: "gateway",
      kind: "inbound.accepted",
      role: "user",
      text: this.input.envelope.message.text ?? "",
      sourceGateway: this.input.envelope.transport,
      sourceRef: this.input.envelope.eventId,
    };
    this.applyDecision(classifyForConversation(event), event);
  }

  admitTurnEvent(event: RuntimeTurnEventInput): void {
    const admissionEvent: ConversationAdmissionInput = {
      source: "runtime_turn_event",
      kind: event.kind,
      payload: event.payload,
      visibility: event.visibility,
      sourceGateway: this.input.envelope.transport,
      sourceRef: `${this.input.turnId}:${event.kind}`,
      knownToolCallIds: this.knownToolCallIds,
    };
    this.applyDecision(classifyForConversation(admissionEvent), admissionEvent);
  }

  admitFinalAssistant(text: string, sourceRef: string): void {
    const event: ConversationAdmissionInput = {
      source: "gateway",
      kind: "outbound.final",
      role: "assistant",
      text,
      sourceGateway: this.input.envelope.transport,
      sourceRef,
    };
    this.applyDecision(classifyForConversation(event), event);
  }

  finalize(status: ConversationTurn["status"], completedAt: string): void {
    this.input.writer.finalizeTurn({
      turnId: this.turn.id,
      status,
      completedAt,
    });
  }

  private applyDecision(decision: AdmissionDecision, event: ConversationAdmissionInput): void {
    this.recordMetric(decision, event);
    if (!decision.operation) return;
    if (decision.operation.kind === "append_message") {
      if (decision.operation.role === "user") {
        this.input.writer.appendUserMessage({
          sessionId: this.turn.session_id,
          turnId: this.turn.id,
          text: decision.operation.text,
          visibility: decision.operation.visibility,
          sourceGateway: decision.operation.sourceGateway,
          sourceRef: decision.operation.sourceRef,
        });
        return;
      }
      if (decision.operation.role === "assistant") {
        this.input.writer.appendAssistantMessage({
          sessionId: this.turn.session_id,
          turnId: this.turn.id,
          text: decision.operation.text,
          visibility: decision.operation.visibility,
          sourceGateway: decision.operation.sourceGateway,
          sourceRef: decision.operation.sourceRef,
        });
      }
      return;
    }
    if (decision.operation.kind === "append_tool_call") {
      this.appendToolCall(decision);
      return;
    }
    if (decision.operation.kind === "append_tool_result") {
      if (!this.toolMessage) return;
      this.input.writer.appendToolResult({
        messageId: this.toolMessage.id,
        toolCallId: decision.operation.toolCallId,
        parentToolCallId: decision.operation.parentToolCallId,
        providerShape: decision.operation.providerShape,
        status: decision.operation.status,
        contentJson: decision.operation.contentJson,
      });
      return;
    }
    if (decision.operation.kind === "write_summary") {
      this.input.writer.writeSummary({
        sessionId: this.turn.session_id,
        coversFromSeq: decision.operation.coversFromSeq,
        coversToSeq: decision.operation.coversToSeq,
        sourceHash: decision.operation.sourceHash,
        summaryText: decision.operation.summaryText,
        model: decision.operation.model,
      });
    }
  }

  private appendToolCall(decision: AdmissionDecision): void {
    const operation = decision.operation;
    if (!operation || operation.kind !== "append_tool_call") return;
    if (!this.toolMessage) {
      this.toolMessage = this.input.writer.appendAssistantMessage({
        sessionId: this.turn.session_id,
        turnId: this.turn.id,
        text: "",
        sourceGateway: this.input.envelope.transport,
        sourceRef: `${this.input.turnId}:${decision.eventKind}:${operation.toolCallId}`,
        parts: [{
          kind: "tool_call",
          contentJson: operation.contentJson,
          toolCallId: operation.toolCallId,
          providerShape: operation.providerShape,
          status: operation.status,
        }],
      });
    } else {
      this.input.writer.appendToolCall({
        messageId: this.toolMessage.id,
        toolCallId: operation.toolCallId,
        providerShape: operation.providerShape,
        status: operation.status,
        contentJson: operation.contentJson,
      });
    }
    this.knownToolCallIds.add(operation.toolCallId);
  }

  private recordMetric(decision: AdmissionDecision, event: ConversationAdmissionInput): void {
    recordConversationAdmissionMetric({
      butlerData: this.input.butlerData,
      sessionId: this.input.binding.sessionId,
      sessionRole: this.input.binding.role,
      event,
      decision,
    });
  }
}
