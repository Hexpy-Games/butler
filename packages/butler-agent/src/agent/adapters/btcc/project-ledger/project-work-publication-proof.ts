import type { ExactLedgerTargetPrecondition } from "./canonical-ledger-reader.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import { requestDigest } from "./project-work-json.ts";

const PROOF_PREFIX = "btcc-project-work-proof-";

export type ProjectWorkPublishedRecord = {
  id: string;
  kind: "work" | "plan" | "reference";
  parentId: string | null;
  title: string;
  status: string;
  spec: string;
  schema: string;
  body: string;
};

export function projectWorkPublicationProofUpdates(
  updates: ProjectLedgerRecordUpdate[],
): ProjectLedgerRecordUpdate[] {
  return updates.map((update) => ({
    operation: "create",
    id: proofId(recordFromUpdate(update)),
    kind: "reference",
    parentId: undefined,
    title: "Project Work publication proof target",
    status: "active",
  }));
}

export function requireProjectWorkPublicationProof(
  targets: ExactLedgerTargetPrecondition[],
  record: ProjectWorkPublishedRecord,
): void {
  const id = proofId(record);
  const matches = targets.filter(
    (target) =>
      target.id === id &&
      target.kind === "reference" &&
      target.parentId === null &&
      target.state === "absent",
  );
  if (matches.length !== 1) invalid();
}

export function assertProjectWorkPublicationTargets(
  updates: ProjectLedgerRecordUpdate[],
  targets: ExactLedgerTargetPrecondition[],
): void {
  const proofs = projectWorkPublicationProofUpdates(updates);
  if (targets.length !== updates.length + proofs.length) invalid();
  const expected = new Set(
    [...updates, ...proofs].map((update) =>
      `${update.kind ?? ""}\0${update.id}\0${update.parentId ?? ""}`,
    ),
  );
  if (
    expected.size !== updates.length + proofs.length ||
    targets.some(
      (target) =>
        !expected.has(`${target.kind}\0${target.id}\0${target.parentId ?? ""}`),
    )
  )
    invalid();
  for (const update of updates)
    requireProjectWorkPublicationProof(
      targets,
      recordFromUpdate(update),
    );
}

function recordFromUpdate(
  update: ProjectLedgerRecordUpdate,
): ProjectWorkPublishedRecord {
  if (
    !update.kind ||
    !["work", "plan", "reference"].includes(update.kind) ||
    !update.title ||
    !update.status ||
    !update.spec ||
    update.body === undefined ||
    update.id.startsWith(PROOF_PREFIX)
  )
    return invalid();
  return {
    id: update.id,
    kind: update.kind as ProjectWorkPublishedRecord["kind"],
    parentId: update.parentId ?? null,
    title: update.title,
    status: update.status,
    spec: update.spec,
    schema: `project-ledger.${update.kind}.v1`,
    body: update.body,
  };
}

function proofId(record: ProjectWorkPublishedRecord): string {
  return `${PROOF_PREFIX}${requestDigest(
    {
      schema: "butler.btcc-project-work-publication-proof.v1",
      record,
    },
  )}`;
}

function invalid(): never {
  throw new Error("project_work_publication_proof_invalid");
}
