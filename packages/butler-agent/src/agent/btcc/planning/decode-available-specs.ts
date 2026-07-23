import { requireRecord, requireString, type ContentRef } from "../core/index.ts";
import type { AvailableSpecRevision } from "./contracts.ts";

export function decodeAvailableSpecs(
  value: unknown,
  legacyRootParentId?: string,
): AvailableSpecRevision[] {
  if (!Array.isArray(value)) throw new Error("availableSpecs must be an array");
  return value.map((item, index) => {
    const spec = requireRecord(item, `availableSpecs[${index}]`);
    const ref = requireRecord(spec.revisionRef, `availableSpecs[${index}].revisionRef`);
    const logicalId = requireString(spec.logicalId, `availableSpecs[${index}].logicalId`);
    return {
      logicalId,
      parentId: optionalString(spec.parentId) ?? requireString(
        legacyRootParentId,
        `availableSpecs[${index}].parentId`,
      ),
      concernId: optionalString(spec.concernId) ?? logicalId,
      title: requireString(spec.title, `availableSpecs[${index}].title`),
      status: requireString(spec.status, `availableSpecs[${index}].status`),
      revisionRef: {
        id: requireString(ref.id, `availableSpecs[${index}].revisionRef.id`),
        sha256: requireString(ref.sha256, `availableSpecs[${index}].revisionRef.sha256`),
      } satisfies ContentRef,
    };
  });
}

export function selectableGoverningSpecIds(
  available: AvailableSpecRevision[],
  admittedRefs: ContentRef[],
): string[] {
  const admitted = new Set(admittedRefs.map(contentRefKey));
  return available
    .filter((spec) => admitted.has(contentRefKey(spec.revisionRef)))
    .map((spec) => spec.logicalId);
}

function contentRefKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
