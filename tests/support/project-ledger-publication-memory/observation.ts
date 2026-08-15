import type { ProjectLedgerPublicationMemoryExternalSample } from "./contracts.ts";

export function mergeExternalPeak(
  previous: ProjectLedgerPublicationMemoryExternalSample | null,
  next: ProjectLedgerPublicationMemoryExternalSample,
): ProjectLedgerPublicationMemoryExternalSample {
  return {
    source: previous?.source ?? next.source,
    rssBytes: maxNullable(previous?.rssBytes ?? null, next.rssBytes),
    physicalFootprintBytes: maxNullable(previous?.physicalFootprintBytes ?? null, next.physicalFootprintBytes),
    privateResidentBytes: maxNullable(previous?.privateResidentBytes ?? null, next.privateResidentBytes),
    workingSetBytes: maxNullable(previous?.workingSetBytes ?? null, next.workingSetBytes),
    privateCommittedBytes: maxNullable(previous?.privateCommittedBytes ?? null, next.privateCommittedBytes),
  };
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
