export function describeProviderCarrierShape(
  carrier: Record<string, unknown>,
): string {
  const submission = recordValue(carrier.submission);
  return JSON.stringify({
    keys: Object.keys(carrier).sort(),
    submissionKeys: submission ? Object.keys(submission).sort() : [],
    requests: describeOperationRequests(carrier.requests),
  });
}

function describeOperationRequests(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((request) => {
    const record = recordValue(request);
    if (!record) return { valueType: typeof request };
    return {
      keys: Object.keys(record).sort(),
      ...safeIdentifier(record, "requestId"),
      ...safeIdentifier(record, "kind"),
      ...safeIdentifier(record, "capabilityRef"),
      ...safeIdentifier(record, "scopeRef"),
      ...safeIdentifier(record, "relativeTarget"),
    };
  });
}

function safeIdentifier(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string" ? { [key]: record[key] } : {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
