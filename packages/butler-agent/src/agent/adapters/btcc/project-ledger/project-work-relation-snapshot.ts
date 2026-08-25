import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import {
  requireCurrentProjectWork,
  type CurrentProjectWorkSnapshot,
} from "./project-work-snapshot.ts";

export type CanonicalProjectWorkRelation = {
  sessionHead: CurrentProjectWorkSnapshot | null;
  binding: CurrentProjectWorkSnapshot | null;
};

export async function requireProjectWorkSessionHead(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  sessionId: string;
}): Promise<CurrentProjectWorkSnapshot> {
  const relation = await readCanonicalProjectWorkRelation(input);
  if (!relation.sessionHead)
    throw new Error("project_work_session_head_invalid");
  return relation.sessionHead;
}

export async function readCanonicalProjectWorkRelation(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  sessionId: string;
  turnId?: string;
}): Promise<CanonicalProjectWorkRelation> {
  return readCanonicalRelationAttempt(input, 1);
}

export async function readCanonicalProjectWorkBinding(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  turnId: string;
}): Promise<CurrentProjectWorkSnapshot | null> {
  const works = await readCanonicalProjectWorks(input.butlerData, input.scope);
  const bindings = works.filter((snapshot) =>
    snapshot.manifest.bindingRefs.some((item) => item.turnId === input.turnId),
  );
  if (bindings.length > 1) invalid();
  return bindings[0] ?? null;
}

async function readCanonicalRelationAttempt(
  input: {
    butlerData: string;
    scope: ResolvedProjectWorkScope;
    sessionId: string;
    turnId?: string;
  },
  attempt: number,
): Promise<CanonicalProjectWorkRelation> {
  const before = await observeProjectLedgerHead(input.scope.ledgerRoot);
  const works = (
    await readCanonicalProjectWorks(input.butlerData, input.scope)
  ).filter(
    (snapshot) => snapshot.view.sessionId === input.sessionId,
  );
  const after = await observeProjectLedgerHead(input.scope.ledgerRoot);
  if (
    before.sourceSha256 !== after.sourceSha256 ||
    before.storageSha256 !== after.storageSha256
  ) {
    if (attempt >= 3) throw new Error("project_work_snapshot_unstable");
    return readCanonicalRelationAttempt(input, attempt + 1);
  }
  const heads = works.filter((snapshot) => snapshot.manifest.sessionHead);
  if (heads.length !== (works.length > 0 ? 1 : 0)) invalid();
  const bindings = input.turnId
    ? works.filter((snapshot) =>
        snapshot.manifest.bindingRefs.some(
          (item) => item.turnId === input.turnId,
        ),
      )
    : [];
  if (bindings.length > 1) invalid();
  return { sessionHead: heads[0] ?? null, binding: bindings[0] ?? null };
}

async function readCanonicalProjectWorks(
  butlerData: string,
  scope: ResolvedProjectWorkScope,
): Promise<CurrentProjectWorkSnapshot[]> {
  const core = await loadProjectLedgerCore();
  const prefix = `project-ledger/projects/${scope.ledgerProjectId}/work/`;
  const candidates = core
    .buildIndex(scope.ledgerRoot)
    .records.filter(
      (record) =>
        record.kind === "work" &&
        record.path.startsWith(prefix) &&
        record.path.endsWith("/work.md"),
    );
  return Promise.all(
    candidates.map((candidate) =>
      requireCurrentProjectWork({ butlerData, scope, workId: candidate.id }),
    ),
  );
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
