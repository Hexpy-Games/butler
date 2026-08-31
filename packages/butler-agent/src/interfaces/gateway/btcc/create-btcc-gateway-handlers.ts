import type {
  GatewayRoleHandlers,
  GatewayRoute,
  InboundEnvelope,
} from "../../../gateways/core/contracts.ts";
import type { BtccTurnRequest } from "../../../agent/btcc/index.ts";
import { subsessionResultId } from "../../../agent/btcc/subsessions/index.ts";
import {
  projectChildTerminalReport,
  projectTurnOutcome,
} from "./project-turn-outcome.ts";
import type { BtccGatewayHandlerOptions } from "./contracts.ts";

export function createBtccGatewayHandlers(
  options: BtccGatewayHandlerOptions,
): GatewayRoleHandlers {
  const handle = async (route: GatewayRoute, envelope: InboundEnvelope) => {
    const turnId = envelope.routingHints?.turnId?.trim() || envelope.eventId;
    if (envelope.control?.kind === "cancel_turn") {
      if (envelope.control.turnId !== turnId) {
        throw new Error("BTCC cancellation identity mismatch");
      }
      const outcome = await options.btcc.stopTurn({ turnId });
      if (outcome.kind !== "cancelled" && outcome.kind !== "already_cancelled") {
        throw new Error(`BTCC cancellation remains recoverable: ${outcome.kind}`);
      }
      await completeChildTerminalResult(options, route, turnId);
      return {
        ok: true,
        handledBy: "btcc/turn-stop",
        metadata: {
          text: "",
          kind: "turn_cancelled",
          turnId,
          appQueueClaimId: envelope.routingHints?.appQueueClaimId,
          safeErrorCode: "turn_cancelled",
          controlAck: {
            kind: "cancel_turn",
            requestId: envelope.control.requestId,
            turnId,
            outcome: outcome.kind,
          },
        },
      };
    }
    const outcome = await options.btcc.runTurn(toBtccRequest(route, envelope, turnId));
    if (outcome.kind === "cancelled" || outcome.kind === "already_cancelled") {
      await completeChildTerminalResult(options, route, turnId);
      return {
        ok: true,
        handledBy: "btcc/turn-cancelled",
        metadata: {
          kind: "turn_cancelled",
          text: "",
          turnId,
          appQueueClaimId: envelope.routingHints?.appQueueClaimId,
          safeErrorCode: "turn_cancelled",
        },
      };
    }
    if (outcome.kind === "already_finalizing" || outcome.kind === "fenced_pending_persistence") {
      throw new Error(`BTCC turn remains recoverable: ${outcome.kind}`);
    }
    const result = projectTurnOutcome(outcome);
    if (options.subsessionDelegation &&
      (outcome.kind === "delivered" || outcome.kind === "already_delivered")) {
      const childReport = projectChildTerminalReport(result);
      if (route.role === "worker") {
        await options.subsessionDelegation.completeWorkerResult({
          childSessionId: route.sessionId,
          childTurnId: outcome.turnId,
          resultId: subsessionResultId(route.sessionId, outcome.turnId),
          summary: childReport.summary,
          status: "success",
          changedArtifacts: childReport.changedArtifacts,
          changedFiles: childReport.changedFiles,
        });
      } else if (route.role === "steward") {
        const activeChildren = await options.subsessionDelegation.activeParentDelegations({
          parentSessionId: route.sessionId,
        });
        if (activeChildren.length === 0) {
          await options.subsessionDelegation.completeStewardResult({
            childSessionId: route.sessionId,
            childTurnId: outcome.turnId,
            resultId: subsessionResultId(route.sessionId, outcome.turnId),
            summary: childReport.summary,
            changedArtifacts: childReport.changedArtifacts,
            changedFiles: childReport.changedFiles,
            status: childTerminalStatus(result.workStatus),
          });
        }
      }
    }
    const generatedSessionTitle = result.text && outcome.admission !== "replay"
      ? await safeTitle(options, envelope, route)
      : null;
    return {
      ok: true,
      handledBy: envelope.control?.kind === "resume_turn"
        ? "btcc/turn-resume"
        : "btcc/turn",
      metadata: {
        text: result.text,
        artifacts: result.artifacts,
        changedFiles: result.changedFiles,
        generatedSessionTitle,
        loadedSkillNames: [],
        ...("modelIdentity" in outcome && outcome.modelIdentity
          ? { executionModel: outcome.modelIdentity }
          : {}),
        durableFinalRecorded: true,
        ...(outcome.kind === "delivered" || outcome.kind === "already_delivered"
          ? { canonicalMessageId: outcome.messageId, turnId: outcome.turnId }
          : { turnId }),
        appQueueClaimId: envelope.routingHints?.appQueueClaimId,
      },
    };
  };

  return {
    butler: ({ route, envelope }) => handle(route, envelope),
    steward: ({ route, envelope }) => handle(route, envelope),
    worker: ({ route, envelope }) => handle(route, envelope),
  };
}

function childTerminalStatus(
  workStatus: "completed" | "blocked" | undefined,
): "success" | "blocked" | "failed" {
  if (workStatus === "completed") return "success";
  if (workStatus === "blocked") return "blocked";
  return "failed";
}

async function completeChildTerminalResult(
  options: BtccGatewayHandlerOptions,
  route: GatewayRoute,
  childTurnId: string,
): Promise<void> {
  if (!options.subsessionDelegation) return;
  const result = {
    childSessionId: route.sessionId,
    childTurnId,
    resultId: subsessionResultId(route.sessionId, childTurnId),
    status: "cancelled" as const,
    code: "steward_cancelled" as const,
  };
  if (route.role === "steward") {
    await options.subsessionDelegation.completeStewardResult(result);
  } else if (route.role === "worker") {
    await options.subsessionDelegation.completeWorkerResult(result);
  }
}

function toBtccRequest(
  route: GatewayRoute,
  envelope: InboundEnvelope,
  turnId: string,
): BtccTurnRequest {
  if (record(envelope.raw)?.btccWake) {
    throw new Error("Raw btccWake is not an authorized BTCC ingress");
  }
  return {
    turnId,
    recoveryAttempt: envelope.routingHints?.turnAttempt,
    sessionId: route.sessionId,
    // A reclaimed App claim is represented by a reconciliation envelope.  Keep
    // the original durable input event as the BTCC identity so the replay can
    // reconcile the existing Turn/result instead of creating a second one.
    eventId: envelope.routingHints?.canonicalEventId ?? envelope.eventId,
    transport: envelope.transport,
    accountId: envelope.accountId,
    peer: envelope.peer,
    sender: envelope.sender,
    message: {
      id: envelope.message.id,
      content: requiredText(envelope.message.text, "BTCC user message"),
      timestamp: envelope.message.timestamp,
      ...(envelope.message.attachments
        ? { attachments: envelope.message.attachments.map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
            ...(Number.isFinite(attachment.sizeBytes)
              ? { sizeBytes: attachment.sizeBytes } : {}),
            ...(attachment.url ? { url: attachment.url } : {}),
            ...(attachment.kind !== "image" && attachment.localPath
              ? { localPath: attachment.localPath }
              : {}),
          })) }
        : {}),
      ...(envelope.message.imageAdmission
        ? { imageAdmission: envelope.message.imageAdmission }
        : {}),
    },
    trigger: { kind: "user_message" },
    route: {
      role: route.role,
      workspacePath: route.workspacePath,
      ...(route.projectId ? { projectId: route.projectId } : {}),
      reason: route.reason,
    },
    ...(envelope.executionControls
      ? { executionControls: envelope.executionControls } : {}),
    emptyResponsePolicy: envelope.routingHints?.appQueueClaimId
      ? "typed_terminal"
      : "safe_fallback",
    ...(envelope.appTurnContext
      ? { appTurnContext: envelope.appTurnContext } : {}),
    ...(envelope.routingHints?.appQueueClaimId
      ? { appQueueClaimId: envelope.routingHints.appQueueClaimId } : {}),
    ...(envelope.signal ? { signal: envelope.signal } : {}),
  };
}

async function safeTitle(
  options: BtccGatewayHandlerOptions,
  envelope: InboundEnvelope,
  route: GatewayRoute,
): Promise<string | null> {
  try {
    return await options.generateSessionTitle?.({ envelope, route }) ?? null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value;
}
