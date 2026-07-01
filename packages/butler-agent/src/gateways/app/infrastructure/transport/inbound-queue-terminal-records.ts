import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  shouldAcceptRecoverableLimitedFinalForFailedQueue,
  terminalClaimId,
} from "./app-delivery-projection.ts";
import {
  isRecord,
  safeInboundQueueId,
  safeOptionalShortToken,
} from "../core/projection-safe-values.ts";

export function queuedFinalProjectionDisposition(input: {
  butlerData: string;
  metadata: Record<string, unknown>;
}): "accept" | "defer" | "reject" {
  const queueId = safeInboundQueueId(input.metadata.queueId);
  const dispatchClaimId = safeOptionalShortToken(
    input.metadata.dispatchClaimId,
  );
  if (!queueId || !dispatchClaimId) return "accept";
  const failed = readInboundQueueTerminalRecord(
    input.butlerData,
    "failed",
    queueId,
  );
  if (failed) {
    return shouldAcceptRecoverableLimitedFinalForFailedQueue(
      input.metadata,
      failed,
      dispatchClaimId,
    )
      ? "accept"
      : "reject";
  }
  const processed = readInboundQueueTerminalRecord(
    input.butlerData,
    "processed",
    queueId,
  );
  const processedClaimId = terminalClaimId(processed);
  if (!processed) return "defer";
  if (!processedClaimId) return "defer";
  return processedClaimId === dispatchClaimId ? "accept" : "reject";
}

export function recoverableLimitedFinalForFailedQueueDisposition(input: {
  butlerData: string;
  metadata: Record<string, unknown>;
}): "accept" | "reject" {
  const queueId = safeInboundQueueId(input.metadata.queueId);
  const dispatchClaimId = safeOptionalShortToken(
    input.metadata.dispatchClaimId,
  );
  if (!queueId || !dispatchClaimId) return "reject";
  const failed = readInboundQueueTerminalRecord(
    input.butlerData,
    "failed",
    queueId,
  );
  if (!failed) return "reject";
  return shouldAcceptRecoverableLimitedFinalForFailedQueue(
    input.metadata,
    failed,
    dispatchClaimId,
  )
    ? "accept"
    : "reject";
}

function readInboundQueueTerminalRecord(
  butlerData: string,
  state: "failed" | "processed",
  queueId: string,
): Record<string, unknown> | null {
  try {
    const text = readFileSync(
      join(butlerData, "runtime", "inbound-events", state, `${queueId}.json`),
      "utf8",
    );
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
