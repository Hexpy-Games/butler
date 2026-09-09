import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
  workIds?: string[];
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
  const before = await projectWorkSourceVersion(input.scope, input.workIds);
  const works = (input.workIds
    ? await readCanonicalProjectWorks(input.butlerData, input.scope, input.workIds)
    : await readCanonicalProjectWorksForSession(
        input.butlerData,
        input.scope,
        input.sessionId,
      )).filter((snapshot) => snapshot.view.sessionId === input.sessionId);
  const after = await projectWorkSourceVersion(input.scope, input.workIds);
  if (before !== after) {
    if (attempt >= 3) throw new Error("project_work_snapshot_unstable");
    return readCanonicalRelationAttempt(input, attempt + 1);
  }
  const heads = works.filter((snapshot) => snapshot.manifest.sessionHead);
  // SQLite is a locator only. A superseded head requires canonical rediscovery.
  if (input.workIds && heads.length === 0) return readCanonicalRelationAttempt({ ...input, workIds: undefined }, 1);
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
  const paths = workRecordPaths(scope);
  return core.readCommittedProjectLedgerRecords(scope.ledgerRoot, paths).flatMap(({ raw }) => {
    if (raw === null) return [];
    const data = core.parseFrontmatter(raw);
    return data?.kind === "work" && typeof data.id === "string" &&
      matches(projectWorkLocator(core.frontmatterBody(raw))) ? [data.id] : [];
  });
}

export async function projectWorkSourceVersion(scope: ResolvedProjectWorkScope, workIds?: string[]): Promise<string> {
  const core = await loadProjectLedgerCore();
  const paths = workRecordPaths(scope, workIds);
  return createHash("sha256").update(JSON.stringify([
    workRecordPaths(scope),
    core.readCommittedProjectLedgerRecords(scope.ledgerRoot, paths),
  ])).digest("hex");
}

function workRecordPaths(scope: ResolvedProjectWorkScope, workIds?: string[]): string[] {
  const directory = join(scope.ledgerRoot, "work");
  const ids = workIds ?? (existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
    : []);
  return [...new Set(ids)].sort().map((id) => `work/${id}/work.md`);
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
