import { createHash } from "node:crypto";
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
import { publishConversationCompletionObservation } from "../cognition/continuity/completion-observation.ts";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import {
  routeTurnInterruption,
  runtimeInterruptionFromUnknown,
} from "../turn/interruption/turn-interruption-router.ts";
import {
  TURN_INTERRUPTION_ENVELOPE_SCHEMA,
  type BtccReportingReceiptInput,
  type BtccTurnStateRecord,
  type TurnInterruptionDirective,
} from "../turn/interruption/turn-interruption-types.ts";

export interface BtccInterruptionStateWriter {
  admitTurn(input: {
    turnId: string;
    sessionId: string;
    attemptId: string;
    now?: string;
  }): BtccTurnStateRecord;
  readTurnState(turnId: string): BtccTurnStateRecord | null;
  applyDirective(directive: TurnInterruptionDirective): BtccTurnStateRecord;
  acceptReportingReceipt(input: BtccReportingReceiptInput): BtccTurnStateRecord;
}

export interface ConversationAdmissionTurnInput {
  writer: ConversationWriter;
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  turnId: string;
  timestamp: string;
  butlerData?: string;
  btccInterruptionStateWriter?: BtccInterruptionStateWriter;
}

export interface ConversationAdmissionProvenance {
  conversationSessionId: string;
  turnId: string;
  inboundMessageId: string;
}

export class ConversationAdmissionTurn {
  private readonly knownToolCallIds = new Set<string>();
  private readonly evidenceRefs = new Set<string>();
  private toolMessage: ConversationMessageWithParts | null = null;
  private requestMessageId: string | null = null;
  private publicAssistantMessageId: string | null = null;

  private constructor(
    private readonly input: ConversationAdmissionTurnInput,
    private readonly turn: ConversationTurn,
  ) {}

  static begin(input: ConversationAdmissionTurnInput): ConversationAdmissionTurn {
    const existing = input.writer.getSessionByGatewayBinding(
      input.envelope.transport,
      input.binding.sessionId,
    );
    const sessionId = existing?.id ?? conversationSessionIdForDurableSession(input.binding.sessionId);
    const turn = input.writer.beginTurn({
      gateway: input.envelope.transport,
      externalSessionId: input.binding.sessionId,
      sessionId,
      workspaceId: null,
      projectId: input.binding.projectId ?? null,
      actor: "user",
      requestId: input.envelope.eventId,
      turnId: input.turnId,
      now: input.timestamp,
    });
    input.btccInterruptionStateWriter?.admitTurn({
      turnId: turn.id,
      sessionId: turn.session_id,
      attemptId: btccAttemptIdForTurn(turn.id),
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

  provenance(): ConversationAdmissionProvenance | null {
    if (!this.requestMessageId) return null;
    return {
      conversationSessionId: this.turn.session_id,
      turnId: this.turn.id,
      inboundMessageId: this.requestMessageId,
    };
  }

  activeRuntimeWait(): { turnId: string; recoveryCaseId: string } | null {
    const current = this.input.btccInterruptionStateWriter?.readTurnState(this.turn.id);
    if (current?.state !== "waiting_runtime" || !current.activeRecoveryCaseId) {
      return null;
    }
    return {
      turnId: current.turnId,
      recoveryCaseId: current.activeRecoveryCaseId,
    };
  }

  routeRuntimeInterruption(input: {
    error: unknown;
    timestamp: string;
  }): { recoveryCaseId: string; state: BtccTurnStateRecord } | null {
    const writer = this.input.btccInterruptionStateWriter;
    const current = writer?.readTurnState(this.turn.id);
    if (!writer || !current) return null;
    if (current.state === "waiting_runtime" && current.activeRecoveryCaseId) {
      return {
        recoveryCaseId: current.activeRecoveryCaseId,
        state: current,
      };
    }
    const checkpointRef = current.lastStableCheckpointRef ??
      `btcc-turn-state:${current.turnId}:g${current.generation}`;
    const interruptionId = `interruption-${stableId({
      turnId: current.turnId,
      attemptId: current.attemptId,
      generation: current.generation,
      origin: "phase_runtime",
    })}`;
    const directive = routeTurnInterruption(runtimeInterruptionFromUnknown({
      error: input.error,
      interruptionId,
      turnId: current.turnId,
      attemptId: current.attemptId,
      origin: "phase_runtime",
      currentGeneration: current.generation,
      lastStableCheckpointRef: checkpointRef,
      createdAt: input.timestamp,
      sideEffectState: "indeterminate",
      resumePredicateRef: `turn-runtime-revision:${current.turnId}:g${current.generation}`,
      diagnosticRefs: [],
    }));
    if (directive.kind !== "waiting_runtime") {
      throw new Error("btcc_runtime_interruption_route_invalid");
    }
    return {
      recoveryCaseId: directive.recoveryCase.recoveryCaseId,
      state: writer.applyDirective(directive),
    };
  }

  acceptPrincipalCancellation(input: {
    cancellationReceiptRef: string;
    timestamp: string;
  }): BtccTurnStateRecord | null {
    const writer = this.input.btccInterruptionStateWriter;
    const current = writer?.readTurnState(this.turn.id);
    if (!writer || !current) return null;
    return writer.applyDirective(routeTurnInterruption({
      schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
      kind: "user_cancellation",
      interruptionId: input.cancellationReceiptRef,
      turnId: current.turnId,
      attemptId: current.attemptId,
      origin: "admission",
      currentGeneration: current.generation,
      lastStableCheckpointRef: current.lastStableCheckpointRef ??
        `btcc-turn-state:${current.turnId}:g${current.generation}`,
      createdAt: input.timestamp,
      cancellationGeneration: current.generation,
      cancellationReceiptRef: input.cancellationReceiptRef,
    }));
  }

  finalize(
    status: ConversationTurn["status"],
    completedAt: string,
    options: { resultDisposition?: BtccReportingReceiptInput["resultDisposition"] } = {},
  ): void {
    const existingOutcome = this.input.writer.readTurnOutcome?.(this.turn.id) ?? null;
    const existingGeneration = existingOutcome?.generation ?? 0;
    const requestMessageId = this.requestMessageId ?? existingOutcome?.request_message_id ?? null;
    const publicAssistantMessageId = this.publicAssistantMessageId ?? existingOutcome?.public_assistant_message_id ?? null;
    if (status === "complete" && this.input.btccInterruptionStateWriter) {
      const current = this.input.btccInterruptionStateWriter.readTurnState(this.turn.id);
      if (!current || !publicAssistantMessageId) {
        throw new Error("btcc_reporting_receipt_prerequisite_missing");
      }
      if (current.state !== "delivered") {
        this.input.btccInterruptionStateWriter.acceptReportingReceipt({
          reportingReceiptId: `reporting-${stableId({
            turnId: current.turnId,
            attemptId: current.attemptId,
            generation: current.generation,
            publicAssistantMessageId,
          })}`,
          turnId: current.turnId,
          attemptId: current.attemptId,
          expectedGeneration: current.generation,
          resultDisposition: options.resultDisposition ?? "fulfilled",
          publicMessageRef: publicAssistantMessageId,
          completionEvidenceRefs: [...this.evidenceRefs],
          createdAt: completedAt,
        });
      }
    }
    this.input.writer.finalizeTurn({
      turnId: this.turn.id,
      status,
      completedAt,
      outcomeCapsule: {
        sessionId: this.turn.session_id,
        turnId: this.turn.id,
        generation: existingGeneration + 1,
        outcome: status === "complete"
          ? "delivered"
          : status === "aborted"
          ? "cancelled"
          : "failed",
        requestMessageId,
        publicAssistantMessageId,
        providerId: this.input.binding.modelRef.split("/", 1)[0] ?? null,
        modelRef: this.input.binding.modelRef,
        evidenceRefs: [...this.evidenceRefs],
        unresolvedObligations: [],
        safeCode: status === "complete" ? null : `turn_${status}`,
        createdAt: completedAt,
      },
    });
    if (
      status === "complete" &&
      this.input.butlerData &&
      requestMessageId &&
      publicAssistantMessageId
    ) {
      try {
        publishConversationCompletionObservation({
          butlerData: this.input.butlerData,
          projectId: this.input.binding.projectId ?? null,
          runtimeSessionId: this.input.binding.sessionId,
          conversationSessionId: this.turn.session_id,
          conversationTurnId: this.turn.id,
          inboundMessageId: requestMessageId,
          outboundMessageId: publicAssistantMessageId,
          outcomeGeneration: existingGeneration + 1,
          completedAt,
        });
        recordOperationalMetric({
          category: "memory",
          name: "completion_observation_publish",
          status: "ok",
          dimensions: {
            scope: this.input.binding.projectId ? "project" : "global",
          },
        }, { butlerData: this.input.butlerData });
      } catch {
        recordOperationalMetric({
          category: "memory",
          name: "completion_observation_publish",
          status: "error",
          dimensions: {
            scope: this.input.binding.projectId ? "project" : "global",
          },
        }, { butlerData: this.input.butlerData });
      }
    }
  }

  finalizeRecoverable(completedAt: string, safeCode: string): void {
    const existingGeneration = this.input.writer.readTurnOutcome?.(this.turn.id)?.generation ?? 0;
    const outcomeCapsule = {
        sessionId: this.turn.session_id,
        turnId: this.turn.id,
        generation: existingGeneration + 1,
        outcome: "recoverable" as const,
        requestMessageId: this.requestMessageId,
        publicAssistantMessageId: this.publicAssistantMessageId,
        providerId: this.input.binding.modelRef.split("/", 1)[0] ?? null,
        modelRef: this.input.binding.modelRef,
        evidenceRefs: [...this.evidenceRefs],
        unresolvedObligations: ["resume_same_logical_turn"],
        continuation: { logical_turn_id: this.turn.id },
        safeCode,
        createdAt: completedAt,
    };
    if (this.input.writer.writeTurnOutcome) {
      this.input.writer.writeTurnOutcome(outcomeCapsule);
      return;
    }
    this.input.writer.finalizeTurn({
      turnId: this.turn.id,
      status: "failed",
      completedAt,
      outcomeCapsule,
    });
  }

  private applyDecision(decision: AdmissionDecision, event: ConversationAdmissionInput): void {
    this.recordMetric(decision, event);
    if (!decision.operation) return;
    if (decision.operation.kind === "append_message") {
      if (decision.operation.role === "user") {
        const message = this.input.writer.appendUserMessage({
          sessionId: this.turn.session_id,
          turnId: this.turn.id,
          text: decision.operation.text,
          visibility: decision.operation.visibility,
          sourceGateway: decision.operation.sourceGateway,
          sourceRef: decision.operation.sourceRef,
        });
        this.requestMessageId ??= message.id;
        return;
      }
      if (decision.operation.role === "assistant") {
        const message = this.input.writer.appendAssistantMessage({
          sessionId: this.turn.session_id,
          turnId: this.turn.id,
          text: decision.operation.text,
          visibility: decision.operation.visibility,
          sourceGateway: decision.operation.sourceGateway,
          sourceRef: decision.operation.sourceRef,
        });
        if (decision.operation.visibility === "user" || event.kind === "outbound.final") {
          this.publicAssistantMessageId = message.id;
        }
      }
      return;
    }
    if (decision.operation.kind === "append_tool_call") {
      this.appendToolCall(decision);
      return;
    }
    if (decision.operation.kind === "append_tool_result") {
      if (!this.toolMessage) return;
      collectEvidenceRefs(decision.operation.contentJson, this.evidenceRefs);
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

function collectEvidenceRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, refs);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["artifact_id", "packet_id", "digest"]) {
    const ref = record[key];
    if (typeof ref === "string" && ref.trim()) refs.add(ref.trim());
  }
  for (const nested of Object.values(record)) collectEvidenceRefs(nested, refs);
}

export function conversationSessionIdForDurableSession(sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return `cs_${hash}`;
}

export function btccAttemptIdForTurn(turnId: string): string {
  return `btcc-attempt-${stableId({ turnId })}`;
}

function stableId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
