import {
  revalidateExactLedgerPreconditions,
  type ExactLedgerRecord,
  type ExactLedgerReadSnapshot,
} from "./canonical-ledger-reader.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import {
  officialWorkStatus,
  PROJECT_WORK_SPEC,
  type ProjectWorkManifest,
} from "./project-work-codec.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import type { ProjectWorkPublishedRecord } from "./project-work-publication-proof.ts";

export async function validateProjectWorkOfficialMetadata(
  scope: ResolvedProjectWorkScope,
  snapshot: ExactLedgerReadSnapshot,
  manifest?: ProjectWorkManifest,
): Promise<ProjectWorkPublishedRecord[]> {
  const core = await loadProjectLedgerCore();
  const publishedRecords: ProjectWorkPublishedRecord[] = [];
  for (const target of snapshot.targetPreconditions) {
    const data = core.readRecordData(
      core.projectPath(scope.ledgerRoot, target.path),
    );
    if (
      !data ||
      data.spec !== PROJECT_WORK_SPEC ||
      data.kind !== target.kind ||
      data.id !== target.id ||
      (data.parentId ?? null) !== target.parentId ||
      data.schema !== `project-ledger.${target.kind}.v1` ||
      typeof data.title !== "string" ||
      !data.title ||
      data.status !==
        (target.kind === "work"
          ? manifest && target.id === manifest.workId
            ? officialWorkStatus(manifest.status)
            : invalid()
          : "active") ||
      hasUnsupportedCompletionMetadata(data)
    )
      invalid();
    const record = requiredRecord(snapshot.records, target.id);
    publishedRecords.push({
      id: target.id,
      kind: target.kind as ProjectWorkPublishedRecord["kind"],
      parentId: target.parentId,
      title: data.title as string,
      status: data.status as string,
      spec: data.spec as string,
      schema: data.schema as string,
      body: record.body,
    });
  }
  await revalidateExactLedgerPreconditions(
    scope.ledgerRoot,
    snapshot.targetPreconditions,
  );
  return publishedRecords;
}

function hasUnsupportedCompletionMetadata(
  data: Record<string, unknown>,
): boolean {
  return [
    "acceptance",
    "acceptanceExemption",
    "validation",
    "review",
    "report",
    "codeCommits",
    "ledgerCommits",
    "requiresCommitEvidence",
  ].some(
    (field) => data[field] !== undefined,
  );
}

function requiredRecord(
  records: ExactLedgerRecord[],
  id: string,
): ExactLedgerRecord {
  const matches = records.filter((record) => record.id === id);
  if (matches.length !== 1) return invalid();
  return matches[0]!;
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
