import { requireRecord, requireString, type ContentRef } from "../core/index.ts";
import type { AvailableSpecRevision } from "./contracts.ts";

export function decodeAvailableSpecs(value: unknown): AvailableSpecRevision[] {
  if (!Array.isArray(value)) throw new Error("availableSpecs must be an array");
  return value.map((item, index) => {
    const spec = requireRecord(item, `availableSpecs[${index}]`);
    const ref = requireRecord(spec.revisionRef, `availableSpecs[${index}].revisionRef`);
    return {
      logicalId: requireString(spec.logicalId, `availableSpecs[${index}].logicalId`),
      title: requireString(spec.title, `availableSpecs[${index}].title`),
      status: requireString(spec.status, `availableSpecs[${index}].status`),
      revisionRef: {
        id: requireString(ref.id, `availableSpecs[${index}].revisionRef.id`),
        sha256: requireString(ref.sha256, `availableSpecs[${index}].revisionRef.sha256`),
      } satisfies ContentRef,
    };
  });
}
