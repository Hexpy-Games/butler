import { existsSync } from "node:fs";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import type { ProjectLedgerCore } from "./project-ledger-core.ts";
import { decodeManifest } from "./project-work-codec.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import { childPath, workPath } from "./project-work-json.ts";
import { hydrateProjectWorkManifest } from "./project-work-snapshot-validation.ts";

/** Validate the changed Work against the sparse candidate over its committed predecessor. */
export function validateProjectWorkPublicationCandidate(input: {
  core: ProjectLedgerCore;
  candidateRoot: string;
  scope: ResolvedProjectWorkScope;
  updates: ProjectLedgerRecordUpdate[];
}): void {
  const workIds = new Set(input.updates.flatMap((update) =>
    update.kind === "work" ? [update.id] : update.parentId ? [update.parentId] : [],
  ));
  const bodyAt = (path: string) => {
    const candidate = input.core.projectPath(input.candidateRoot, path);
    const committed = input.core.projectPath(input.scope.ledgerRoot, path);
    const selected = existsSync(candidate) ? candidate : committed;
    return existsSync(selected) ? input.core.readRecordBody(selected) : null;
  };
  for (const workId of workIds) {
    const body = bodyAt(workPath(input.scope.ledgerProjectId, workId));
    if (body === null) invalid();
    const manifest = decodeManifest(body!, { workId, scope: input.scope });
    hydrateProjectWorkManifest(manifest, (id) => {
      const plan = bodyAt(childPath(input.scope.ledgerProjectId, "plan", id));
      const reference = bodyAt(childPath(input.scope.ledgerProjectId, "reference", id));
      if ((plan === null) === (reference === null)) return invalid();
      return (plan ?? reference)!;
    });
  }
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
