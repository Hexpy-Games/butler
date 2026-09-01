import type { ExactLedgerRecord } from "./canonical-ledger-reader.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import type { ProjectLedgerCore } from "./project-ledger-core.ts";
import { validateManagedProjectWorkChildren } from "./project-work-managed-children.ts";
import { decodeManifest } from "./project-work-codec.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import { hydrateProjectWorkManifest } from "./project-work-snapshot-validation.ts";

export function validateProjectWorkPublicationCandidate(input: {
  core: ProjectLedgerCore;
  candidateRoot: string;
  scope: ResolvedProjectWorkScope;
  updates: ProjectLedgerRecordUpdate[];
}): void {
  const workIds = new Set(
    input.updates.flatMap((update) =>
      update.kind === "work"
        ? [update.id]
        : update.parentId && ["plan", "reference"].includes(update.kind ?? "")
          ? [update.parentId]
          : [],
    ),
  );
  if (workIds.size === 0) return;

  const index = input.core.buildIndex(input.candidateRoot);
  const records = index.records.map((record) => {
    const filePath = input.core.projectPath(input.candidateRoot, record.path);
    const data = input.core.readRecordData(filePath);
    const body = input.core.readRecordBody(filePath);
    return {
      id: record.id,
      kind: record.kind,
      path: record.path,
      parentId: typeof data?.parentId === "string" ? data.parentId : null,
      body,
    };
  });

  for (const workId of workIds) {
    const work = records.filter(
      (record) => record.id === workId && record.kind === "work",
    );
    if (work.length !== 1 || work[0]?.body === null) invalid();
    const manifest = decodeManifest(work[0]!.body!, {
      workId,
      scope: input.scope,
    });
    const children = records
      .filter(
        (record) =>
          record.parentId === workId &&
          ["plan", "reference"].includes(record.kind) &&
          record.body !== null,
      )
      .map((record): ExactLedgerRecord => ({
        id: record.id,
        kind: record.kind,
        path: record.path,
        parentId: workId,
        rawRecordSha256: "candidate",
        body: record.body!,
      }));
    validateManagedProjectWorkChildren(manifest, children);
    hydrateProjectWorkManifest(manifest, (id) => {
      const matches = children.filter((record) => record.id === id);
      if (matches.length !== 1) return invalid();
      return matches[0]!.body;
    });
  }
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
