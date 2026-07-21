import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { WorkspaceProvision } from "../../artifact/index.ts";
import type { ObservationResult, OperationRequest } from "../../core/index.ts";
import type { MaterializedSnapshot, TargetKind } from "./target-snapshot.ts";

export type StoredWorkspace = {
  key: string;
  provision: WorkspaceProvision;
  targetPath: string;
  targetKind: TargetKind;
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
  finalSnapshotRef: { id: string; sha256: string };
  status: "reserved" | "prepared" | "commit_intent_durable" | "committed";
};

export type WorkspaceActionJournal = {
  request: Extract<OperationRequest, { kind: "workspace_artifact_action" }>;
  workspaceRef: { id: string; sha256: string };
  overlayRoot: string;
  beforeSnapshotRef: { id: string; sha256: string };
  status: "reserved" | "dispatching" | "candidate_prepared" | "workspace_exchanged";
  candidateSnapshotRef?: { id: string; sha256: string };
  result?: ObservationResult;
};

export class ArtifactStore {
  private readonly database: Database;

  constructor(butlerData: string) {
    const path = join(butlerData, "runtime", "btcc-artifacts.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS btcc_artifact_workspaces (
        workspace_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS btcc_artifact_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS btcc_artifact_operations (
        request_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL
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

  saveWorkspace(workspace: StoredWorkspace, baseline: MaterializedSnapshot): void {
    this.database.transaction(() => {
      this.saveSnapshot(baseline);
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
    return this.readJson<MaterializedSnapshot>(
      "SELECT value_json FROM btcc_artifact_snapshots WHERE snapshot_id = ?",
      snapshotId,
    );
  }

  saveSnapshot(snapshotValue: MaterializedSnapshot): void {
    this.database.query(`
      INSERT INTO btcc_artifact_snapshots(snapshot_id, value_json)
      VALUES (?, ?)
      ON CONFLICT(snapshot_id) DO NOTHING
    `).run(snapshotValue.ref.id, JSON.stringify(snapshotValue));
    const accepted = this.loadSnapshot(snapshotValue.ref.id);
    if (!accepted || JSON.stringify(accepted) !== JSON.stringify(snapshotValue)) {
      throw new Error("BTCC snapshot identity conflicts with its materialized bytes");
    }
  }

  loadOperation(request: OperationRequest): ObservationResult | null {
    const row = this.database.query(`
      SELECT request_json, result_json FROM btcc_artifact_operations WHERE request_id = ?
    `).get(request.requestId) as { request_json: string; result_json: string } | null;
    if (!row) return null;
    assertSameRequest(row.request_json, request);
    return JSON.parse(row.result_json) as ObservationResult;
  }

  saveOperation(request: OperationRequest, result: ObservationResult): void {
    this.database.query(`
      INSERT INTO btcc_artifact_operations(request_id, request_json, result_json)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(request.requestId, JSON.stringify(request), JSON.stringify(result));
    const accepted = this.loadOperation(request);
    if (!accepted || JSON.stringify(accepted) !== JSON.stringify(result)) {
      throw new Error("BTCC operation request identity conflict");
    }
  }

  loadPromotion(request: Extract<OperationRequest, { kind: "repository_promotion" }>): PromotionIntent | null {
    const row = this.database.query(`
      SELECT request_json, value_json FROM btcc_artifact_promotions WHERE request_id = ?
    `).get(request.requestId) as { request_json: string; value_json: string } | null;
    if (!row) return null;
    assertSameRequest(row.request_json, request);
    return JSON.parse(row.value_json) as PromotionIntent;
  }

  savePromotion(intent: PromotionIntent): void {
    const requestJson = JSON.stringify(intent.request);
    this.database.query(`
      INSERT INTO btcc_artifact_promotions(request_id, request_json, value_json)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(intent.request.requestId, requestJson, JSON.stringify(intent));
    const existing = this.database.query(`
      SELECT request_json FROM btcc_artifact_promotions WHERE request_id = ?
    `).get(intent.request.requestId) as { request_json: string } | null;
    if (!existing) throw new Error("BTCC promotion intent was not persisted");
    assertSameRequest(existing.request_json, intent.request);
    this.database.query(`
      UPDATE btcc_artifact_promotions SET value_json = ?
      WHERE request_id = ? AND request_json = ?
    `).run(JSON.stringify(intent), intent.request.requestId, requestJson);
  }

  loadWorkspaceAction(
    request: Extract<OperationRequest, { kind: "workspace_artifact_action" }>,
  ): WorkspaceActionJournal | null {
    const row = this.database.query(`
      SELECT request_json, value_json FROM btcc_artifact_workspace_actions WHERE request_id = ?
    `).get(request.requestId) as { request_json: string; value_json: string } | null;
    if (!row) return null;
    assertSameRequest(row.request_json, request);
    return JSON.parse(row.value_json) as WorkspaceActionJournal;
  }

  saveWorkspaceAction(journal: WorkspaceActionJournal): void {
    const requestJson = JSON.stringify(journal.request);
    this.database.query(`
      INSERT INTO btcc_artifact_workspace_actions(request_id, request_json, value_json)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `).run(journal.request.requestId, requestJson, JSON.stringify(journal));
    const existing = this.database.query(`
      SELECT request_json FROM btcc_artifact_workspace_actions WHERE request_id = ?
    `).get(journal.request.requestId) as { request_json: string } | null;
    if (!existing) throw new Error("BTCC workspace action journal was not persisted");
    assertSameRequest(existing.request_json, journal.request);
    this.database.query(`
      UPDATE btcc_artifact_workspace_actions SET value_json = ?
      WHERE request_id = ? AND request_json = ?
    `).run(JSON.stringify(journal), journal.request.requestId, requestJson);
  }

  private readJson<Value>(sql: string, identity: string): Value | null {
    const row = this.database.query(sql).get(identity) as { value_json: string } | null;
    return row ? JSON.parse(row.value_json) as Value : null;
  }
}

function assertSameRequest(storedJson: string, request: OperationRequest): void {
  if (storedJson !== JSON.stringify(request)) {
    throw new Error("BTCC operation request identity conflict");
  }
}
