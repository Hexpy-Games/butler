import type { ObservationResult, OperationRequest } from "./contracts.ts";
import { contentRef } from "./record-codec.ts";

export class OperationRejectedError extends Error {
  override readonly name = "OperationRejectedError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function rejectedOperationResult(
  request: OperationRequest,
  error: OperationRejectedError,
): ObservationResult {
  const content = JSON.stringify({
    status: "rejected",
    code: error.code,
    message: error.message,
  });
  return {
    requestId: request.requestId,
    outcome: "operation_rejected",
    observationRef: contentRef("operation-rejection", {
      requestId: request.requestId,
      capabilityRef: request.capabilityRef,
      code: error.code,
    }),
    content,
  };
}
