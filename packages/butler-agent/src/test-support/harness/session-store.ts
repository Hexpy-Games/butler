import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { resolve } from "node:path";
import type {
  SessionBinding,
  SessionBindingLookup,
  SessionLifecycleState,
  SessionTransportBinding,
  StoredSessionBinding,
} from "./contracts.ts";
import {
  coordinateSharedSqliteWriter,
  type SqliteStorageProfile,
} from "../../foundation/sqlite-writer-coordination.ts";
import { openOwnedSqliteConnection, type OwnedSqliteConnection } from
  "../../foundation/sqlite/owned-sqlite-connection.ts";

interface SessionRow {
  session_id: string;
  role: StoredSessionBinding["role"];
  lifecycle_state: SessionLifecycleState;
  project_id: string | null;
  app_project_id: string | null;
  ledger_project_id: string | null;
  workspace_path: string;
  runtime_adapter_id: string;
  model_provider_id: string;
  model_ref: string;
  runtime_session_ref: string | null;
  provider_thread_ref: string | null;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
  metadata_json: string | null;
}

interface TransportBindingRow {
  transport: string;
  account_id: string;
  peer_id: string;
  thread_id: string;
}

type UpsertSessionBindingInput = SessionBinding &
  Partial<Pick<StoredSessionBinding, "lifecycleState" | "createdAt" | "updatedAt" | "lastActiveAt" | "metadata">>;

const DEFAULT_ACTIVE_STATES: SessionLifecycleState[] = ["active", "closing"];

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function normalizeThreadId(threadId?: string | null): string {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : "";
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function dedupeTransportBindings(bindings: SessionTransportBinding[]): SessionTransportBinding[] {
  const seen = new Set<string>();
  const deduped: SessionTransportBinding[] = [];

  for (const binding of bindings) {
    const normalized: SessionTransportBinding = {
      transport: binding.transport,
      accountId: binding.accountId,
      peerId: binding.peerId,
      threadId: normalizeThreadId(binding.threadId) || undefined,
    };
    const key = [
      normalized.transport,
      normalized.accountId,
      normalized.peerId,
      normalized.threadId ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

export function sessionStoreDir(): string {
  return join(getButlerData(), "runtime");
}

export function sessionStorePath(): string {
  return join(sessionStoreDir(), "session-store.sqlite");
}

export class SessionBindingStore {
  private readonly connection: OwnedSqliteConnection;
  private readonly db: OwnedSqliteConnection["database"];

  constructor(
    private readonly dbPath = sessionStorePath(),
    storageProfile: SqliteStorageProfile = "durable",
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.connection = openOwnedSqliteConnection(dbPath);
    this.db = this.connection.database;
    coordinateSharedSqliteWriter(this.db, storageProfile);
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.ensureSchema();
  }

  close(): void {
    this.connection.close();
  }

  get path(): string {
    return this.dbPath;
  }

  /** Repair the old general-session default; never alter a project/worktree. */
  relocateLegacyGeneralWorkspaces(programHome: string, butlerData: string): number {
    return this.db.query(`
      UPDATE session_bindings SET workspace_path = ?
      WHERE workspace_path = ?
        AND COALESCE(project_id, '') = '' AND COALESCE(app_project_id, '') = ''
        AND COALESCE(ledger_project_id, '') = ''
        AND json_extract(COALESCE(metadata_json, '{}'), '$.sessionWorkspace') IS NULL
    `).run(resolve(butlerData), resolve(programHome)).changes;
  }

  upsert(binding: UpsertSessionBindingInput): StoredSessionBinding {
    const existing = this.getBySessionId(binding.sessionId);
    const now = binding.updatedAt ?? new Date().toISOString();
    const lifecycleState = binding.lifecycleState ?? existing?.lifecycleState ?? "active";
    const createdAt = binding.createdAt ?? existing?.createdAt ?? now;
    const lastActiveAt =
      binding.lastActiveAt ??
      existing?.lastActiveAt ??
      (lifecycleState === "closed" || lifecycleState === "crashed" ? undefined : now);
    const metadata = binding.metadata ?? existing?.metadata;
    const transportBindings = dedupeTransportBindings(binding.transportBindings);
    const appProjectId = Object.hasOwn(binding, "appProjectId")
      ? binding.appProjectId
      : existing?.appProjectId ?? binding.projectId;
    const ledgerProjectId = Object.hasOwn(binding, "ledgerProjectId")
      ? binding.ledgerProjectId
      : existing?.ledgerProjectId;

    const upsertSession = this.db.query(`
      INSERT INTO session_bindings (
        session_id,
        role,
        lifecycle_state,
        project_id,
        app_project_id,
        ledger_project_id,
        workspace_path,
        runtime_adapter_id,
        model_provider_id,
        model_ref,
        runtime_session_ref,
        provider_thread_ref,
        created_at,
        updated_at,
        last_active_at,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        role = excluded.role,
        lifecycle_state = excluded.lifecycle_state,
        project_id = excluded.project_id,
        app_project_id = excluded.app_project_id,
        ledger_project_id = excluded.ledger_project_id,
        workspace_path = excluded.workspace_path,
        runtime_adapter_id = excluded.runtime_adapter_id,
        model_provider_id = excluded.model_provider_id,
        model_ref = excluded.model_ref,
        runtime_session_ref = excluded.runtime_session_ref,
        provider_thread_ref = excluded.provider_thread_ref,
        updated_at = excluded.updated_at,
        last_active_at = excluded.last_active_at,
        metadata_json = excluded.metadata_json
    `);
    const deleteBindings = this.db.query(`
      DELETE FROM session_transport_bindings
      WHERE session_id = ?
    `);
    const insertBinding = this.db.query(`
      INSERT INTO session_transport_bindings (
        session_id,
        transport,
        account_id,
        peer_id,
        thread_id
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((normalizedBindings: SessionTransportBinding[]) => {
      upsertSession.run(
        binding.sessionId,
        binding.role,
        lifecycleState,
        binding.projectId ?? null,
        appProjectId ?? null,
        ledgerProjectId ?? null,
        binding.workspacePath,
        binding.runtimeAdapterId,
        binding.modelProviderId,
        binding.modelRef,
        binding.runtimeSessionRef ?? null,
        binding.providerThreadRef ?? null,
        createdAt,
        now,
        lastActiveAt ?? null,
        metadata ? JSON.stringify(metadata) : null,
      );
      deleteBindings.run(binding.sessionId);
      for (const item of normalizedBindings) {
        insertBinding.run(
          binding.sessionId,
          item.transport,
          item.accountId,
          item.peerId,
          normalizeThreadId(item.threadId),
        );
      }
    });

    tx(transportBindings);
    return this.getBySessionId(binding.sessionId)!;
  }

  rebindWorkspace(input: {
    sessionId: string;
    expectedUpdatedAt: string;
    workspacePath: string;
    metadata: Record<string, unknown>;
    updatedAt?: string;
  }):
    | { status: "applied"; binding: StoredSessionBinding }
    | { status: "changed"; binding: StoredSessionBinding | null }
    | { status: "missing" } {
    const current = this.getBySessionId(input.sessionId);
    if (!current) return { status: "missing" };
    const updatedAt = input.updatedAt && input.updatedAt > input.expectedUpdatedAt
      ? input.updatedAt
      : this.nextRevisionTimestamp(input.expectedUpdatedAt);
    const updated = this.db.query(`
      UPDATE session_bindings
      SET workspace_path = ?, metadata_json = ?, updated_at = ?
      WHERE session_id = ? AND updated_at = ?
    `).run(
      input.workspacePath,
      JSON.stringify(input.metadata),
      updatedAt,
      input.sessionId,
      input.expectedUpdatedAt,
    ) as { changes: number };
    const binding = this.getBySessionId(input.sessionId);
    if (updated.changes !== 1) return { status: "changed", binding };
    if (!binding) return { status: "changed", binding: null };
    return { status: "applied", binding };
  }

  private nextRevisionTimestamp(previous: string): string {
    const previousMs = Date.parse(previous);
    const nowMs = Date.now();
    const nextMs = Number.isFinite(previousMs) ? Math.max(nowMs, previousMs + 1) : nowMs;
    return new Date(nextMs).toISOString();
  }

  getBySessionId(sessionId: string): StoredSessionBinding | null {
    const row = this.db.query(`
      SELECT
        session_id,
        role,
        lifecycle_state,
        project_id,
        app_project_id,
        ledger_project_id,
        workspace_path,
        runtime_adapter_id,
        model_provider_id,
        model_ref,
        runtime_session_ref,
        provider_thread_ref,
        created_at,
        updated_at,
        last_active_at,
        metadata_json
      FROM session_bindings
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId) as SessionRow | null;

    if (!row) return null;
    return this.hydrateSession(row);
  }

  listSessions(options?: { lifecycleState?: SessionLifecycleState | SessionLifecycleState[] }): StoredSessionBinding[] {
    const states = options?.lifecycleState
      ? Array.isArray(options.lifecycleState)
        ? options.lifecycleState
        : [options.lifecycleState]
      : [];

    const where = states.length > 0
      ? `WHERE lifecycle_state IN (${states.map(() => "?").join(", ")})`
      : "";
    const rows = this.db.query(`
      SELECT
        session_id,
        role,
        lifecycle_state,
        project_id,
        app_project_id,
        ledger_project_id,
        workspace_path,
        runtime_adapter_id,
        model_provider_id,
        model_ref,
        runtime_session_ref,
        provider_thread_ref,
        created_at,
        updated_at,
        last_active_at,
        metadata_json
      FROM session_bindings
      ${where}
      ORDER BY updated_at DESC, session_id ASC
    `).all(...states) as SessionRow[];

    return rows.map((row) => this.hydrateSession(row));
  }

  resolveTransportBinding(lookup: SessionBindingLookup): StoredSessionBinding | null {
    const threadId = normalizeThreadId(lookup.threadId);
    const states = lookup.includeInactive ? [] : DEFAULT_ACTIVE_STATES;
    const baseParams = [lookup.transport, lookup.accountId, lookup.peerId];

    if (threadId) {
      const exactWhere = this.lifecycleFilter(states, "s");
      const exactRow = this.db.query(`
        SELECT
          s.session_id,
          s.role,
          s.lifecycle_state,
          s.project_id,
          s.app_project_id,
          s.ledger_project_id,
          s.workspace_path,
          s.runtime_adapter_id,
          s.model_provider_id,
          s.model_ref,
          s.runtime_session_ref,
          s.provider_thread_ref,
          s.created_at,
          s.updated_at,
          s.last_active_at,
          s.metadata_json
        FROM session_bindings s
        JOIN session_transport_bindings t ON t.session_id = s.session_id
        WHERE t.transport = ?
          AND t.account_id = ?
          AND t.peer_id = ?
          AND (t.thread_id = ? OR t.thread_id = '')
          ${exactWhere.sql}
        ORDER BY
          CASE WHEN t.thread_id = ? THEN 0 ELSE 1 END ASC,
          s.updated_at DESC,
          s.session_id ASC
        LIMIT 1
      `).get(...baseParams, threadId, ...exactWhere.params, threadId) as SessionRow | null;

      if (exactRow) {
        return this.hydrateSession(exactRow);
      }
    }

    const baseWhere = this.lifecycleFilter(states, "s");
    const row = this.db.query(`
      SELECT
        s.session_id,
        s.role,
        s.lifecycle_state,
        s.project_id,
        s.app_project_id,
        s.ledger_project_id,
        s.workspace_path,
        s.runtime_adapter_id,
        s.model_provider_id,
        s.model_ref,
        s.runtime_session_ref,
        s.provider_thread_ref,
        s.created_at,
        s.updated_at,
        s.last_active_at,
        s.metadata_json
      FROM session_bindings s
      JOIN session_transport_bindings t ON t.session_id = s.session_id
      WHERE t.transport = ?
        AND t.account_id = ?
        AND t.peer_id = ?
        AND t.thread_id = ''
        ${baseWhere.sql}
      ORDER BY s.updated_at DESC, s.session_id ASC
      LIMIT 1
    `).get(...baseParams, ...baseWhere.params) as SessionRow | null;

    return row ? this.hydrateSession(row) : null;
  }

  updateLifecycleState(
    sessionId: string,
    lifecycleState: SessionLifecycleState,
    at = new Date().toISOString(),
  ): StoredSessionBinding | null {
    const nextLastActiveAt =
      lifecycleState === "active" || lifecycleState === "closing" ? at : null;

    this.db.query(`
      UPDATE session_bindings
      SET lifecycle_state = ?, updated_at = ?, last_active_at = ?
      WHERE session_id = ?
    `).run(lifecycleState, at, nextLastActiveAt, sessionId);

    return this.getBySessionId(sessionId);
  }

  touchSession(sessionId: string, at = new Date().toISOString()): StoredSessionBinding | null {
    this.db.query(`
      UPDATE session_bindings
      SET updated_at = ?, last_active_at = ?
      WHERE session_id = ?
    `).run(at, at, sessionId);

    return this.getBySessionId(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.db.query(`
      DELETE FROM session_bindings
      WHERE session_id = ?
    `).run(sessionId);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_bindings (
        session_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        project_id TEXT,
        app_project_id TEXT,
        ledger_project_id TEXT,
        workspace_path TEXT NOT NULL,
        runtime_adapter_id TEXT NOT NULL,
        model_provider_id TEXT NOT NULL,
        model_ref TEXT NOT NULL,
        runtime_session_ref TEXT,
        provider_thread_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS session_transport_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES session_bindings(session_id) ON DELETE CASCADE,
        transport TEXT NOT NULL,
        account_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT ''
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_transport_unique
        ON session_transport_bindings (session_id, transport, account_id, peer_id, thread_id);

      CREATE INDEX IF NOT EXISTS idx_session_transport_lookup
        ON session_transport_bindings (transport, account_id, peer_id, thread_id);

      CREATE INDEX IF NOT EXISTS idx_session_lifecycle_state
        ON session_bindings (lifecycle_state, updated_at);
    `);
    this.ensureColumn("session_bindings", "app_project_id", "TEXT");
    this.ensureColumn("session_bindings", "ledger_project_id", "TEXT");
    this.db.exec(`
      UPDATE session_bindings
      SET app_project_id = project_id
      WHERE app_project_id IS NULL AND project_id IS NOT NULL;
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.query<{ name: string }, []>(
      `PRAGMA table_info(${table})`,
    ).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private hydrateSession(row: SessionRow): StoredSessionBinding {
    return {
      sessionId: row.session_id,
      role: row.role,
      lifecycleState: row.lifecycle_state,
      projectId: row.project_id ?? undefined,
      appProjectId: row.app_project_id ?? row.project_id ?? undefined,
      ledgerProjectId: row.ledger_project_id ?? undefined,
      workspacePath: row.workspace_path,
      runtimeAdapterId: row.runtime_adapter_id,
      modelProviderId: row.model_provider_id,
      modelRef: row.model_ref as SessionBinding["modelRef"],
      runtimeSessionRef: row.runtime_session_ref ?? undefined,
      providerThreadRef: row.provider_thread_ref ?? undefined,
      transportBindings: this.transportBindingsForSession(row.session_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActiveAt: row.last_active_at ?? undefined,
      metadata: parseMetadata(row.metadata_json),
    };
  }

  private transportBindingsForSession(sessionId: string): SessionTransportBinding[] {
    const rows = this.db.query(`
      SELECT transport, account_id, peer_id, thread_id
      FROM session_transport_bindings
      WHERE session_id = ?
      ORDER BY transport ASC, account_id ASC, peer_id ASC, thread_id ASC
    `).all(sessionId) as TransportBindingRow[];

    return rows.map((row) => ({
      transport: row.transport,
      accountId: row.account_id,
      peerId: row.peer_id,
      threadId: normalizeThreadId(row.thread_id) || undefined,
    }));
  }

  private lifecycleFilter(states: SessionLifecycleState[], alias: string): { sql: string; params: string[] } {
    if (states.length === 0) return { sql: "", params: [] };
    return {
      sql: `AND ${alias}.lifecycle_state IN (${states.map(() => "?").join(", ")})`,
      params: [...states],
    };
  }
}
