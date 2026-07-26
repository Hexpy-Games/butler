import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { WorkspaceProvision } from "../../artifact/index.ts";
import type {
  ObservationResult,
  OperationPayloadSource,
  OperationRequest,
} from "../../core/index.ts";
import type { CommandExecutionSummary } from "../../operation-result/index.ts";
import {
  ArtifactSnapshotRepository,
  type MaterializedSnapshot,
  type TargetKind,
} from "../artifact-snapshot/index.ts";

export type StoredWorkspace = {
  key: string;
  provision: WorkspaceProvision;
  targetPath: string;
  targetKind: TargetKind;
  baselineTargetState: "present" | "absent";
  workspaceRoot: string;
  baselineSnapshotRef: { id: string; sha256: string };
};

export type PromotionIntent = {
  request: Extract<OperationRequest, { kind: "repository_promotion" }>;
  transactionId: string;
  workspaceRef: { id: string; sha256: string };
  targetPath: string;
  stagedPath: string;
  baselineSnapshotRef: { id: string; sha256: string };
  baselineTargetState: "present" | "absent";
  finalSnapshotRef: { id: string; sha256: string };
  status: "reserved" | "prepared" | "commit_intent_durable" | "committed" | "closed";
  cleanupRootRef?: { id: string; sha256: string };
};

export type WorkspaceActionJournal = {
  request: Extract<OperationRequest, { kind: "workspace_artifact_action" }>;
  workspaceRef: { id: string; sha256: string };
  beforeSnapshotRef: { id: string; sha256: string };
  status:
    | "reserved" | "dispatching" | "tool_completed" | "workspace_observed"
    | "candidate_prepared" | "workspace_applied";
  operationOutput?: {
    content: string;
    payloadSource?: Exclude<OperationPayloadSource, string>;
    executionSummary?: CommandExecutionSummary;
  };
  candidateSnapshotRef?: { id: string; sha256: string };
  result?: ObservationResult;
};

export class ArtifactStore {
  private readonly database: Database;
  readonly snapshots: ArtifactSnapshotRepository;

  constructor(butlerData: string) {
    const path = join(butlerData, "runtime", "btcc-artifacts.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    removeLegacyArtifactRuntime(path, butlerData);
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS btcc_artifact_workspaces (
        workspace_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS btcc_artifact_promotions (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS btcc_artifact_workspace_actions (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        value_json TEXT NOT NULL
      );
    `);
    this.database.exec("PRAGMA user_version = 2;");
    this.snapshots = new ArtifactSnapshotRepository(
      this.database,
      join(butlerData, "runtime", "btcc-artifact-blobs", "sha256"),
    );
  }

  loadWorkspaceByKey(key: string): StoredWorkspace | null {
    return this.readJson<StoredWorkspace>(
      "SELECT value_json FROM btcc_artifact_workspaces WHERE workspace_key = ?",
      key,
    );
  }

  loadWorkspaceByRef(workspaceId: string): StoredWorkspace | null {
    return this.readJson<StoredWorkspace>(
      "SELECT value_json FROM btcc_artifact_workspaces WHERE workspace_id = ?",
      workspaceId,
    );
  }

  saveWorkspace(workspace: StoredWorkspace): void {
    this.database.transaction(() => {
      this.database.query(`
        INSERT INTO btcc_artifact_workspaces(workspace_key, workspace_id, value_json)
        VALUES (?, ?, ?)
        ON CONFLICT(workspace_key) DO NOTHING
      `).run(workspace.key, workspace.provision.workspace.ref.id, JSON.stringify(workspace));
    })();
    const accepted = this.loadWorkspaceByKey(workspace.key);
    if (!accepted || JSON.stringify(accepted) !== JSON.stringify(workspace)) {
      throw new Error("BTCC workspace identity conflicts with its durable mapping");
    }
  }

  loadSnapshot(snapshotId: string): MaterializedSnapshot | null {
    return this.snapshots.load(snapshotId);
  }

  loadPromotion(
    scopeId: string,
    request: Extract<OperationRequest, { kind: "repository_promotion" }>,
  ): PromotionIntent | null {
    const row = this.database.query(`
      SELECT request_json, value_json FROM btcc_artifact_promotions WHERE request_id = ?
    `).get(scopedRequestId(scopeId, request)) as { request_json: string; value_json: string } | null;
    if (!row) return null;
    assertSameRequest(row.request_json, request);
    return JSON.parse(row.value_json) as PromotionIntent;
  }

  savePromotion(scopeId: string, intent: PromotionIntent): void {
    const requestJson = JSON.stringify(intent.request);
    const requestId = scopedRequestId(scopeId, intent.request);
    this.database.query(`
      INSERT INTO btcc_artifact_promotions(request_id, request_json, value_json)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(requestId, requestJson, JSON.stringify(intent));
    const existing = this.database.query(`
      SELECT request_json FROM btcc_artifact_promotions WHERE request_id = ?
    `).get(requestId) as { request_json: string } | null;
    if (!existing) throw new Error("BTCC promotion intent was not persisted");
    assertSameRequest(existing.request_json, intent.request);
    this.database.query(`
      UPDATE btcc_artifact_promotions SET value_json = ?
      WHERE request_id = ? AND request_json = ?
    `).run(JSON.stringify(intent), requestId, requestJson);
  }

  loadWorkspaceAction(
    scopeId: string,
    request: Extract<OperationRequest, { kind: "workspace_artifact_action" }>,
  ): WorkspaceActionJournal | null {
    const row = this.database.query(`
      SELECT request_json, value_json FROM btcc_artifact_workspace_actions WHERE request_id = ?
    `).get(scopedRequestId(scopeId, request)) as { request_json: string; value_json: string } | null;
    if (!row) return null;
    assertSameRequest(row.request_json, request);
    return JSON.parse(row.value_json) as WorkspaceActionJournal;
  }

  saveWorkspaceAction(scopeId: string, journal: WorkspaceActionJournal): void {
    const requestJson = JSON.stringify(journal.request);
    const requestId = scopedRequestId(scopeId, journal.request);
    this.database.query(`
      INSERT INTO btcc_artifact_workspace_actions(request_id, request_json, value_json)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(requestId, requestJson, JSON.stringify(journal));
    const existing = this.database.query(`
      SELECT request_json FROM btcc_artifact_workspace_actions WHERE request_id = ?
    `).get(requestId) as { request_json: string } | null;
    if (!existing) throw new Error("BTCC workspace action journal was not persisted");
    assertSameRequest(existing.request_json, journal.request);
    this.database.query(`
      UPDATE btcc_artifact_workspace_actions SET value_json = ?
      WHERE request_id = ? AND request_json = ?
    `).run(JSON.stringify(journal), requestId, requestJson);
  }

  private readJson<Value>(sql: string, identity: string): Value | null {
    const row = this.database.query(sql).get(identity) as { value_json: string } | null;
    return row ? JSON.parse(row.value_json) as Value : null;
  }
}

function removeLegacyArtifactRuntime(path: string, butlerData: string): void {
  if (!existsSync(path) || !isLegacyArtifactDatabase(path)) return;
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(join(butlerData, "runtime", "btcc-artifacts"), {
    recursive: true,
    force: true,
  });
}

function isLegacyArtifactDatabase(path: string): boolean {
  const database = new Database(path, { readonly: true });
  try {
    const row = database
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'btcc_artifact_snapshots'`,
      )
      .get();
    return Boolean(row);
  } finally {
    database.close();
  }
}

function scopedRequestId(scopeId: string, request: OperationRequest): string {
  return `${scopeId}:${request.requestId}`;
}

function assertSameRequest(storedJson: string, request: OperationRequest): void {
  if (storedJson !== JSON.stringify(request)) {
    throw new Error("BTCC operation request identity conflict");
  }
}
