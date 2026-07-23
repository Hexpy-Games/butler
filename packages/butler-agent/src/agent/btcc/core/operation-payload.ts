import type { OperationPayloadSource } from "./contracts.ts";

export type SpooledOperationOutput = {
  kind: "spooled_operation_output";
  summary: unknown;
  payloadSource: Exclude<OperationPayloadSource, string>;
};

export function isSpooledOperationOutput(
  value: unknown,
): value is SpooledOperationOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SpooledOperationOutput>;
  return candidate.kind === "spooled_operation_output" &&
    candidate.summary !== undefined &&
    candidate.payloadSource?.kind === "spooled_text";
}
