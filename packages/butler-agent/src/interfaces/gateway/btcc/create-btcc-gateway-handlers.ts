import type {
  GatewayRoleHandlers,
  GatewayRoute,
  InboundEnvelope,
} from "../../../gateways/core/contracts.ts";
import type {
  BtccTurnRequest,
} from "../../../agent/btcc/index.ts";
import { projectTurnOutcome } from "./project-turn-outcome.ts";
import type { BtccGatewayHandlerOptions } from "./contracts.ts";

export function createBtccGatewayHandlers(
  options: BtccGatewayHandlerOptions,
): GatewayRoleHandlers {
  const handle = async (route: GatewayRoute, envelope: InboundEnvelope) => {
    const turnId = envelope.routingHints?.turnId?.trim() || envelope.eventId;
    const request = toBtccRequest(route, envelope, turnId);
    const outcome = await options.btcc.runTurn(request);
    const result = projectTurnOutcome(outcome);
    const generatedSessionTitle = result.text && outcome.admission !== "replay"
      ? await safeTitle(options, envelope, route)
      : null;
    return {
      ok: true,
      handledBy: "btcc/turn",
      metadata: {
        text: result.text,
        artifacts: [],
        generatedSessionTitle,
        loadedSkillNames: [],
        durableFinalRecorded: true,
        ...(outcome.kind === "delivered" || outcome.kind === "already_delivered"
          ? { canonicalMessageId: outcome.messageId, turnId: outcome.turnId }
          : { turnId }),
      },
    };
  };

  return {
    butler: ({ route, envelope }) => handle(route, envelope),
    steward: ({ route, envelope }) => handle(route, envelope),
  };
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
    sessionId: route.sessionId,
    eventId: envelope.eventId,
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
