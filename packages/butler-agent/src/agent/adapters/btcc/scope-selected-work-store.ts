import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  DurableWorkStore,
  WorkTurnScope,
} from "../../btcc/work/index.ts";
import type { StoredSessionBinding } from
  "../../../test-support/harness/contracts.ts";
import type { SessionBindingStore } from
  "../../../test-support/harness/session-store.ts";
import type { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { ensureActiveProjectLedger } from
  "../../../integrations/project-ledger/ensure-active-project-ledger.ts";
import {
  createProjectWorkStore,
  type ProjectWorkLegacyRuntime,
  type ProjectWorkResultRuntime,
  type ProjectWorkRuntimeProjection,
  type ResolvedProjectWorkScope,
} from "./project-ledger/index.ts";
import { SqliteGuidedWorkStore } from "./sqlite/guided-work-store.ts";

class ScopeSelectedWorkStoreError extends Error {
  readonly code = "work_scope_turn_missing";

  constructor() {
    super("work_scope_turn_missing");
    this.name = "ScopeSelectedWorkStoreError";
  }
}

export type ProductionWorkSelection = {
  butlerHome: string;
  butlerData: string;
  sessionBindings: SessionBindingStore;
  projectLedgerResolver: ActiveProjectLedgerResolver;
};

export type ProjectWorkStoreFactory = (
  scope: ResolvedProjectWorkScope,
) => DurableWorkStore;

export type PersistedWorkTurnScope = {
  kind: "unbound" | "session" | "project";
  sessionId: string;
  appProjectId?: string;
  ledgerProjectId?: string;
};

export function createScopeSelectedWorkStore(input: {
  sessionBindings: SessionBindingStore;
  sessionStore: DurableWorkStore;
  resolveProjectScope(binding: StoredSessionBinding): ResolvedProjectWorkScope;
  createProjectStore: ProjectWorkStoreFactory;
  persistedScopeForTurn(turnId: string): PersistedWorkTurnScope | null;
}): DurableWorkStore {
  return new ScopeSelectedWorkStore(input);
}

export function createProductionScopeSelectedWorkStore(input: {
  db: Database;
  sessionStore: SqliteGuidedWorkStore;
  selection: ProductionWorkSelection;
  runtimeProjection: ProjectWorkRuntimeProjection;
  resultRuntime: ProjectWorkResultRuntime;
  legacyRuntime: ProjectWorkLegacyRuntime;
}): DurableWorkStore {
  return createScopeSelectedWorkStore({
    sessionBindings: input.selection.sessionBindings,
    sessionStore: input.sessionStore,
    resolveProjectScope(binding) {
      const appProjectId = binding.appProjectId ?? binding.projectId;
      if (!appProjectId) throw new Error("work_scope_project_binding_missing");
      const reference = ensureActiveProjectLedger({
        resolver: input.selection.projectLedgerResolver,
        butlerHome: input.selection.butlerHome,
        butlerData: input.selection.butlerData,
        lookup: {
          appProjectId,
          workspacePath: binding.workspacePath,
          ...(binding.ledgerProjectId
            ? {
                explicitRef: join(
                  input.selection.butlerData,
                  "project-ledger",
                  "projects",
                  binding.ledgerProjectId,
                ),
              }
            : {}),
        },
      });
      if (
        reference.app_project_id !== appProjectId ||
        (binding.ledgerProjectId &&
          reference.ledger_project_id !== binding.ledgerProjectId)
      ) {
        throw new Error("work_scope_project_resolution_mismatch");
      }
      return {
        appProjectId: reference.app_project_id,
        ledgerProjectId: reference.ledger_project_id,
        ledgerRoot: realpathSync(reference.ledger_root),
      };
    },
    createProjectStore(scope) {
      return createProjectWorkStore({
        butlerData: input.selection.butlerData,
        scope,
        runtimeProjection: input.runtimeProjection,
        resultRuntime: input.resultRuntime,
        legacyRuntime: input.legacyRuntime,
      });
    },
    persistedScopeForTurn: (turnId) =>
      persistedScopeForTurn(input.db, turnId),
  });
}

class ScopeSelectedWorkStore implements DurableWorkStore {
  private readonly projectStores = new Map<string, DurableWorkStore>();

  constructor(private readonly input: Parameters<typeof createScopeSelectedWorkStore>[0]) {}

  loadContext(scope: WorkTurnScope) {
    return this.storeForScope(scope).loadContext(scope);
  }
  importOpenLegacyWork(scope: WorkTurnScope) {
    return this.storeForScope(scope).importOpenLegacyWork(scope);
  }
  bindOpenWork(scope: WorkTurnScope, expectedWorkId?: string) {
    return this.storeForScope(scope).bindOpenWork(scope, expectedWorkId);
  }
  startWork(command: Parameters<DurableWorkStore["startWork"]>[0]) {
    return this.storeForScope(command).startWork(command);
  }
  continueWork(command: Parameters<DurableWorkStore["continueWork"]>[0]) {
    return this.storeForScope(command).continueWork(command);
  }
  replacePlan(command: Parameters<DurableWorkStore["replacePlan"]>[0]) {
    return this.storeForScope(command).replacePlan(command);
  }
  recordCheckpoint(command: Parameters<DurableWorkStore["recordCheckpoint"]>[0]) {
    return this.storeForScope(command).recordCheckpoint(command);
  }
  recordReview(command: Parameters<DurableWorkStore["recordReview"]>[0]) {
    return this.storeForScope(command).recordReview(command);
  }
  recordDisposition(command: Parameters<DurableWorkStore["recordDisposition"]>[0]) {
    return this.storeForScope(command).recordDisposition(command);
  }
  claimCloseoutCorrection(
    command: Parameters<DurableWorkStore["claimCloseoutCorrection"]>[0],
  ) {
    return this.storeForScope(command).claimCloseoutCorrection(command);
  }
  attachToolResult(command: Parameters<DurableWorkStore["attachToolResult"]>[0]) {
    return this.storeForScope(command).attachToolResult(command);
  }
  boundWorkForTurn(turnId: string) {
    return this.storeForTurn(turnId).boundWorkForTurn(turnId);
  }
  abandonBoundWorkForTurn(turnId: string) {
    return this.storeForTurn(turnId).abandonBoundWorkForTurn(turnId);
  }

  private storeForScope(scope: WorkTurnScope): DurableWorkStore {
    const binding = this.requireBinding(scope.sessionId);
    if (isLocalWorker(binding)) {
      if (scope.projectRef) throw new Error("work_scope_session_binding_mismatch");
      return this.input.sessionStore;
    }
    const appProjectId = binding.appProjectId ?? binding.projectId;
    if (!appProjectId) {
      if (scope.projectRef) throw new Error("work_scope_session_binding_mismatch");
      return this.input.sessionStore;
    }
    if (scope.projectRef !== appProjectId) {
      throw new Error("work_scope_project_binding_mismatch");
    }
    return this.projectStore(binding);
  }

  private storeForTurn(turnId: string): DurableWorkStore {
    const persisted = this.input.persistedScopeForTurn(turnId);
    if (!persisted) throw new ScopeSelectedWorkStoreError();
    if (persisted.kind === "session") return this.input.sessionStore;
    if (persisted.kind === "unbound") {
      const binding = this.requireBinding(persisted.sessionId);
      if (isLocalWorker(binding)) return this.input.sessionStore;
      return binding.appProjectId ?? binding.projectId
        ? this.projectStore(binding)
        : this.input.sessionStore;
    }
    const binding = this.requireBinding(persisted.sessionId);
    const appProjectId = binding.appProjectId ?? binding.projectId;
    if (
      !appProjectId ||
      appProjectId !== persisted.appProjectId ||
      (binding.ledgerProjectId &&
        binding.ledgerProjectId !== persisted.ledgerProjectId)
    ) {
      throw new Error("work_scope_project_projection_mismatch");
    }
    const resolved = this.input.resolveProjectScope(binding);
    if (
      resolved.appProjectId !== persisted.appProjectId ||
      resolved.ledgerProjectId !== persisted.ledgerProjectId
    ) {
      throw new Error("work_scope_project_projection_mismatch");
    }
    return this.cachedProjectStore(resolved);
  }

  private projectStore(binding: StoredSessionBinding): DurableWorkStore {
    const resolved = this.input.resolveProjectScope(binding);
    const appProjectId = binding.appProjectId ?? binding.projectId;
    if (
      resolved.appProjectId !== appProjectId ||
      (binding.ledgerProjectId &&
        resolved.ledgerProjectId !== binding.ledgerProjectId)
    ) {
      throw new Error("work_scope_project_resolution_mismatch");
    }
    return this.cachedProjectStore(resolved);
  }

  private cachedProjectStore(scope: ResolvedProjectWorkScope): DurableWorkStore {
    const key = JSON.stringify(scope);
    const existing = this.projectStores.get(key);
    if (existing) return existing;
    const created = this.input.createProjectStore(scope);
    this.projectStores.set(key, created);
    return created;
  }

  private requireBinding(sessionId: string): StoredSessionBinding {
    const binding = this.input.sessionBindings.getBySessionId(sessionId);
    if (!binding) throw new Error("work_scope_session_binding_missing");
    return binding;
  }
}

function isLocalWorker(binding: StoredSessionBinding): boolean {
  if (binding.role !== "worker") return false;
  const policy = binding.metadata?.runtimePolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const value = (policy as Record<string, unknown>).trackingMode ??
    (policy as Record<string, unknown>).tracking_mode;
  return value === "local";
}

function persistedScopeForTurn(
  db: Database,
  turnId: string,
): PersistedWorkTurnScope | null {
  const rows = db.query<{
    session_id: string;
    scope_kind: "session" | "project";
    scope_ref: string;
    ledger_project_id: string | null;
  }, [string]>(`
    SELECT work.session_id, work.scope_kind, work.scope_ref,
      work.ledger_project_id
    FROM btcc_guided_turn_work_bindings binding
    JOIN btcc_guided_works work ON work.work_id = binding.work_id
    WHERE binding.turn_id = ? AND binding.is_current = 1
    ORDER BY binding.revision DESC
    LIMIT 2
  `).all(turnId);
  if (rows.length > 1) throw new Error("work_scope_turn_binding_ambiguous");
  const row = rows[0];
  if (!row) {
    const turn = db.query<{ session_id: string }, [string]>(`
      SELECT session_id FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    return turn
      ? { kind: "unbound", sessionId: turn.session_id }
      : null;
  }
  if (row.scope_kind === "session") {
    return { kind: "session", sessionId: row.session_id };
  }
  if (!row.ledger_project_id) {
    throw new Error("work_scope_project_projection_incomplete");
  }
  return {
    kind: "project",
    sessionId: row.session_id,
    appProjectId: row.scope_ref,
    ledgerProjectId: row.ledger_project_id,
  };
}
