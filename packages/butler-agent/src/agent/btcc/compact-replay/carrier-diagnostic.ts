export type CompactReplayCarrierRejectionReason =
  | "phase_continuity_required_first"
  | "phase_continuity_schema_invalid"
  | "phase_continuity_rewrite_failed"
  | "operation_required"
  | "operation_carrier_mixed";

export type CompactReplayCarrierPropertyType =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "string"
  | "unknown";

export type CompactReplayCarrierPropertyShape = {
  name: string;
  type: CompactReplayCarrierPropertyType;
};

export type CompactReplayCarrierDiagnostic = {
  schemaPath: string;
  reason: CompactReplayCarrierRejectionReason;
  properties: CompactReplayCarrierPropertyShape[];
};

export function compactReplayArgumentPropertyShape(
  value: Record<string, unknown>,
): CompactReplayCarrierPropertyShape[] {
  return Object.keys(value).sort().slice(0, 24).map((name, index) => ({
    name: boundedCompactReplayIdentifier(name, `property_${index}`, 80),
    type: argumentValueType(value[name]),
  }));
}

export function compactReplayCarrierDiagnostic(
  value: Record<string, unknown> | undefined,
): CompactReplayCarrierDiagnostic | null {
  if (!value || Object.keys(value).length !== 1) return null;
  const diagnostic = record(value.carrier_rejection);
  if (!diagnostic || Object.keys(diagnostic).some((key) =>
    !["schema_path", "reason", "properties"].includes(key))) return null;
  if (!isRejectionReason(diagnostic.reason) ||
    diagnostic.schema_path !== schemaPathForReason(diagnostic.reason) ||
    !Array.isArray(diagnostic.properties) || diagnostic.properties.length > 24) {
    return null;
  }
  const properties = diagnostic.properties.flatMap((property) => {
    const shape = record(property);
    return shape && Object.keys(shape).length === 2 &&
        typeof shape.name === "string" && isBoundedIdentifier(shape.name, 80) &&
        isPropertyType(shape.type)
      ? [{ name: shape.name, type: shape.type }]
      : [];
  });
  if (properties.length !== diagnostic.properties.length) return null;
  return {
    schemaPath: diagnostic.schema_path,
    reason: diagnostic.reason,
    properties,
  };
}

export function boundedCompactReplayIdentifier(
  value: string,
  fallback: string,
  maxLength = 120,
): string {
  const bounded = value.slice(0, maxLength).replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return bounded || fallback;
}

function argumentValueType(value: unknown): CompactReplayCarrierPropertyType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return type;
  if (type === "object") return "object";
  return "unknown";
}

function schemaPathForReason(reason: CompactReplayCarrierRejectionReason): string {
  if (reason === "phase_continuity_required_first") return "$.toolCalls[0].name";
  if (reason === "phase_continuity_schema_invalid") {
    return "$.toolCalls[0].arguments";
  }
  if (reason === "operation_required") {
    return "$.toolCalls[0].arguments.operations";
  }
  if (reason === "operation_carrier_mixed") return "$.toolCalls[1]";
  return "$.toolCalls[0]";
}

function isRejectionReason(
  value: unknown,
): value is CompactReplayCarrierRejectionReason {
  return value === "phase_continuity_required_first" ||
    value === "phase_continuity_schema_invalid" ||
    value === "phase_continuity_rewrite_failed" ||
    value === "operation_required" || value === "operation_carrier_mixed";
}

function isPropertyType(
  value: unknown,
): value is CompactReplayCarrierPropertyType {
  return value === "array" || value === "boolean" || value === "null" ||
    value === "number" || value === "object" || value === "string" ||
    value === "unknown";
}

function isBoundedIdentifier(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength &&
    /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
