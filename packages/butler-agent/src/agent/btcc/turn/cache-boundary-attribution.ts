import type { ButlerContextInput } from "../contracts.ts";

export function providerRequestAttributionMetadata(
  metadata: unknown,
): Pick<ButlerContextInput, "providerRequestAttribution"> {
  const root = object(metadata);
  const boundary = object(root.m1CacheBoundaryEvidence);
  const armId = text(root.m1AttributionArmId);
  const expectedRevision = text(boundary.expectedRevision);
  const observedRevision = text(boundary.observedRevision);
  return armId || (expectedRevision && observedRevision)
    ? { providerRequestAttribution: {
        ...(armId ? { armId } : {}),
        ...(expectedRevision && observedRevision ? { cacheBoundaryEvidence: {
          expectedRevision,
          observedRevision,
        } } : {}),
      } }
    : {};
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
