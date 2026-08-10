import { REPLACE_PHASE_CONTINUITY_TOOL_NAME } from
  "../../tools/m1-compact-replay.ts";

type OperationCarrierCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
};

/** Expands one atomic provider carrier into the existing ordered execution batch. */
export function expandCompactReplayOperationCarrierCalls<
  T extends OperationCarrierCall,
>(input: {
  enabled: boolean;
  calls: readonly T[];
}): T[] {
  if (!input.enabled || input.calls.length !== 1) return [...input.calls];
  const carrier = input.calls[0];
  if (!carrier || carrier.name !== REPLACE_PHASE_CONTINUITY_TOOL_NAME) {
    return [...input.calls];
  }
  const operations = carrierOperations(carrier.arguments.operations);
  if (!operations) return [...input.calls];
  return [
    {
      ...carrier,
      arguments: withoutCompactReplayCarrierOperations(carrier.arguments),
      rawArguments: carrier.rawArguments ?? JSON.stringify(carrier.arguments),
    },
    ...operations.map((operation, index) => ({
      ...carrier,
      id: operation.operationId || `${carrier.id}:operation:${index}`,
      name: operation.name,
      arguments: operation.arguments,
      rawArguments: JSON.stringify(operation.arguments),
    } as T)),
  ];
}

export function withoutCompactReplayCarrierOperations(
  arguments_: Record<string, unknown>,
): Record<string, unknown> {
  const { operations: _operations, ...continuity } = arguments_;
  return continuity;
}

function carrierOperations(value: unknown): Array<{
  operationId: string;
  name: string;
  arguments: Record<string, unknown>;
}> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    return null;
  }
  const operations = value.flatMap((item) => {
    const operation = record(item);
    const arguments_ = record(operation?.arguments);
    return operation && typeof operation.operation_id === "string" &&
        operation.operation_id.length > 0 && operation.operation_id.length <= 160 &&
        typeof operation.name === "string" && arguments_
      ? [{
          operationId: operation.operation_id,
          name: operation.name,
          arguments: arguments_,
        }]
      : [];
  });
  return operations.length === value.length ? operations : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
