export function toolResultPayloadForProvider(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payload;
}

export function serializeToolResultPayloadForProvider(
  payload: Record<string, unknown>,
): string {
  return JSON.stringify(payload);
}
