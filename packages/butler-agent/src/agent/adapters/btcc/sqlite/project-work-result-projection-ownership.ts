import type { Database } from "bun:sqlite";
import type { ProjectWorkRuntimeProjection } from "../project-ledger/index.ts";

type ProjectionInput = Parameters<
  ProjectWorkRuntimeProjection["observeCanonicalWorks"]
>[0];
type ProjectionBinding = ProjectionInput["works"][number]["bindings"][number] & {
  workId: string;
  sessionId: string;
};
type BindingRow = {
  binding_revision_id: string;
  turn_id: string;
  session_id: string;
  work_id: string;
  revision: number;
  is_current: number;
  bound_at: string;
};
type ResultIdentity = {
  resultRef: string;
  toolCallId: string;
  workId: string;
  sequence: number;
  originTurnId: string;
  attachedAt: string;
};
type ResultRow = {
  result_ref: string;
  work_id: string;
  sequence: number;
  tool_call_id: string;
  origin_turn_id: string;
  attached_at: string;
};

/** Fails before projection repair whenever an existing row has another owner. */
export function assertProjectWorkProjectionOwnership(
  db: Database,
  input: ProjectionInput,
): void {
  const workIds = new Set(input.works.map(({ work }) => work.workId));
  const sessionIds = new Set(input.works.map(({ work }) => work.sessionId));
  for (const { work } of input.works) {
    if (work.scope.kind !== "project") conflict();
    const row = db.query<{
      session_id: string;
      scope_kind: string;
      scope_ref: string;
      ledger_project_id: string | null;
    }, [string]>(`
      SELECT session_id, scope_kind, scope_ref, ledger_project_id
      FROM btcc_guided_works WHERE work_id = ?
    `).get(work.workId);
    if (row && (
      row.session_id !== work.sessionId || row.scope_kind !== "project" ||
      row.scope_ref !== work.scope.projectRef ||
      (row.ledger_project_id === null
        ? input.legacyImportClaimWorkId !== work.workId
        : row.ledger_project_id !== input.ledgerProjectId)
    )) conflict();
  }

  const heads = db.query<{ session_id: string; work_id: string }, []>(`
    SELECT session_id, work_id FROM btcc_guided_work_session_heads
  `).all();
  for (const row of heads) {
    if (!sessionIds.has(row.session_id) && !workIds.has(row.work_id)) continue;
    const expected = input.works.find(
      ({ work }) => work.sessionId === row.session_id,
    );
    if (!expected || row.work_id !== input.sessionHeadWorkId) conflict();
  }

  const bindings: ProjectionBinding[] = input.works.flatMap(({ work, bindings }) =>
    bindings.map((binding) => ({
      ...binding,
      workId: work.workId,
      sessionId: work.sessionId,
    })),
  );
  const bindingIds = new Set(bindings.map((item) => item.bindingRevisionId));
  const currentTurns = new Set(
    bindings.filter((item) => item.isCurrent).map((item) => item.turnId),
  );
  const bindingRows = db.query<BindingRow, []>(`
    SELECT binding_revision_id, turn_id, session_id, work_id,
      revision, is_current, bound_at
    FROM btcc_guided_turn_work_bindings
  `).all();
  for (const row of bindingRows) {
    const touches = workIds.has(row.work_id) ||
      bindingIds.has(row.binding_revision_id) ||
      bindings.some((item) =>
        item.turnId === row.turn_id && item.revision === row.revision) ||
      (row.is_current === 1 && currentTurns.has(row.turn_id));
    if (!touches) continue;
    const exact = bindings.some((item) =>
      item.bindingRevisionId === row.binding_revision_id &&
      item.turnId === row.turn_id && item.sessionId === row.session_id &&
      item.workId === row.work_id && item.revision === row.revision &&
      item.boundAt === row.bound_at);
    if (!exact) conflict();
  }

  const results = input.works.flatMap(({ work }) =>
    work.resultRefs.map((result, index) => ({
      ...result,
      workId: work.workId,
      sequence: index + 1,
    })),
  );
  assertProjectWorkResultOwnership(db, results, workIds);
}

export function assertProjectWorkResultOwnership(
  db: Database,
  results: ResultIdentity[],
  workIds: Set<string>,
): void {
  const rows = db.query<ResultRow, []>(`
    SELECT result_ref, work_id, sequence, tool_call_id,
      origin_turn_id, attached_at FROM btcc_guided_work_results
  `).all();
  for (const row of rows) {
    const touches = workIds.has(row.work_id) || results.some((item) =>
      item.resultRef === row.result_ref || item.toolCallId === row.tool_call_id ||
      (item.workId === row.work_id && item.sequence === row.sequence));
    if (!touches) continue;
    const exact = results.some((item) =>
      item.resultRef === row.result_ref && item.toolCallId === row.tool_call_id &&
      item.workId === row.work_id && item.sequence === row.sequence &&
      item.originTurnId === row.origin_turn_id && item.attachedAt === row.attached_at);
    if (!exact) conflict();
  }
}

function conflict(): never {
  throw new Error("project_work_runtime_ownership_conflict");
}
