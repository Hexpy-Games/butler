import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import {
  requireExactCurrentProjectWork,
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
  workIds?: string[];
}): Promise<CanonicalProjectWorkRelation> {
  return readCanonicalRelationAttempt(input, 1);
}

export async function readCanonicalProjectWorkBinding(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  turnId: string;
  workIds?: string[];
}): Promise<CurrentProjectWorkSnapshot | null> {
  const works = input.workIds
    ? await readCanonicalProjectWorks(input.butlerData, input.scope, input.workIds)
    : await readCanonicalProjectWorksForTurn(
        input.butlerData,
        input.scope,
        input.turnId,
      );
  const bindings = works.filter((snapshot) => snapshot.manifest.bindingRefs.some(
    (item) => item.turnId === input.turnId,
  ));
  if (bindings.length > 1) invalid();
  return bindings[0] ?? null;
}

async function readCanonicalRelationAttempt(
  input: {
    butlerData: string;
    scope: ResolvedProjectWorkScope;
    sessionId: string;
    turnId?: string;
    workIds?: string[];
  },
  attempt: number,
): Promise<CanonicalProjectWorkRelation> {
  const before = input.workIds
    ? null
    : await observeProjectLedgerHead(input.scope.ledgerRoot);
  const works = (input.workIds
    ? await readCanonicalProjectWorks(input.butlerData, input.scope, input.workIds)
    : await readCanonicalProjectWorksForSession(
        input.butlerData,
        input.scope,
        input.sessionId,
      )).filter((snapshot) => snapshot.view.sessionId === input.sessionId);
  const after = before
    ? await observeProjectLedgerHead(input.scope.ledgerRoot)
    : null;
  if (before && after && (
    before.sourceSha256 !== after.sourceSha256 ||
    before.storageSha256 !== after.storageSha256
  )) {
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

async function readCanonicalProjectWorksForSession(
  butlerData: string,
  scope: ResolvedProjectWorkScope,
  sessionId: string,
): Promise<CurrentProjectWorkSnapshot[]> {
  const workIds = await locateCanonicalProjectWorkIds(
    scope,
    (manifest) => manifest.sessionId === sessionId,
  );
  return readCanonicalProjectWorks(butlerData, scope, workIds);
}

async function readCanonicalProjectWorksForTurn(
  butlerData: string,
  scope: ResolvedProjectWorkScope,
  turnId: string,
): Promise<CurrentProjectWorkSnapshot[]> {
  const workIds = await locateCanonicalProjectWorkIds(
    scope,
    (manifest) => manifest.bindingTurnIds.includes(turnId),
  );
  return readCanonicalProjectWorks(butlerData, scope, workIds);
}

async function locateCanonicalProjectWorkIds(
  scope: ResolvedProjectWorkScope,
  matches: (manifest: ProjectWorkLocator) => boolean,
): Promise<string[]> {
  const core = await loadProjectLedgerCore();
  const prefix = `project-ledger/projects/${scope.ledgerProjectId}/work/`;
  return core
    .buildIndex(scope.ledgerRoot)
    .records.filter(
      (record) =>
        record.kind === "work" &&
        record.path.startsWith(prefix) &&
        record.path.endsWith("/work.md"),
    )
    .filter((record) => {
      const body = core.readRecordBody(
        core.projectPath(scope.ledgerRoot, record.path),
      );
      return body ? matches(projectWorkLocator(body)) : false;
    })
    .map((record) => record.id);
}

function readCanonicalProjectWorks(
  butlerData: string,
  scope: ResolvedProjectWorkScope,
  workIds: string[],
): Promise<CurrentProjectWorkSnapshot[]> {
  return Promise.all(
    [...new Set(workIds)].map((workId) =>
      requireExactCurrentProjectWork({ butlerData, scope, workId }),
    ),
  );
}

type ProjectWorkLocator = {
  sessionId: string | null;
  bindingTurnIds: string[];
};

function projectWorkLocator(body: string): ProjectWorkLocator {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { sessionId: null, bindingTurnIds: [] };
  }
  if (value.schema !== "butler.btcc-project-work.v1")
    return { sessionId: null, bindingTurnIds: [] };
  const bindingTurnIds = Array.isArray(value.bindingRefs)
    ? value.bindingRefs.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const turnId = (item as Record<string, unknown>).turnId;
        return typeof turnId === "string" ? [turnId] : [];
      })
    : [];
  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    bindingTurnIds,
  };
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
