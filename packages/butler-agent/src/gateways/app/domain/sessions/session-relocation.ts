import type { Database } from "bun:sqlite";
import { AgentConversationStore } from "../../../../agent/conversation/store.ts";
import { prepareWorkspaceForRelocation, discardRelocationWorkspace, type PreparedRelocationWorkspace } from "../../../../agent/session-workspaces/index.ts";
import type { StoredSessionBinding } from "../../../../test-support/harness/contracts.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import type { SettingsView, SessionSummary } from "../../interface/protocol/app-protocol.ts";
import type { SpaceMutationResult } from "../../interface/protocol/space-contract.ts";
import type { AppSessionWorkspaceBindingStore } from "./session-workspace-binding-store.ts";
import type { AppSpaceOrganization } from "./space-organization.ts";
import type { StewardObserverReader } from "./steward-observer.ts";
import { AppSessionContextGate } from "./session-context-gate.ts";
import { containerScope, requireSpaceNode, spaceError } from "./space-tree.ts";
import { sessionHintForRow } from "./session-read-model.ts";

export interface RelocateSessionRequest {
  operationId: string;
  sessionId: string;
  expectedRevision: number;
  targetKey: string | null;
  position: "inside" | "before" | "after";
}
type Destination = { parentKey: string | null; targetKey: string | null; position: RelocateSessionRequest["position"]; project: ProjectRow | null };
type Before = { binding: StoredSessionBinding; projectId: string | null; parentKey: string | null; ownerPid: number };
type Row = { operation_id: string; session_id: string; phase: "preparing" | "prepared" | "bound" | "committed" | "aborted"; from_json: string; to_json: string; prepared_json: string | null; error_code: string | null };
const RUNNING_RELOCATIONS = new Set<string>();
const CLEANING_RELOCATIONS = new Set<string>();

export class AppSessionRelocation {
  private readonly gate: AppSessionContextGate;
  constructor(private readonly input: {
    db: Database; butlerData: string; bindings: AppSessionWorkspaceBindingStore;
    space: AppSpaceOrganization; observer: StewardObserverReader;
    getSession(id: string): SessionSummary; getProject(id: string): ProjectRow | null;
    getSettings(): SettingsView; appendEvent(type: string, payload: Record<string, unknown>): void;
  }) { this.gate = new AppSessionContextGate(input.db); }

  async relocate(request: RelocateSessionRequest): Promise<SpaceMutationResult> {
    if (RUNNING_RELOCATIONS.has(request.operationId)) spaceError("session_relocating", "대화를 이동하고 있습니다.");
    const prior = this.row(request.operationId);
    if (prior) {
      const target = JSON.parse(prior.to_json) as Destination;
      if (prior.session_id !== request.sessionId || target.targetKey !== request.targetKey || target.position !== request.position)
        spaceError("relocation_identity_conflict", "이동 요청의 내용이 달라졌습니다.");
      this.recover(prior);
      const phase = this.row(request.operationId)?.phase;
      if (phase !== "committed") spaceError(phase === "aborted" ? "relocation_aborted" : "session_relocating", "이동이 완료되지 않았습니다. 이동 상태를 다시 확인해 주세요.");
      return { space: this.input.space.read() };
    }
    this.recoverPending();
    const record = this.input.db.transaction(() => this.reserve(request))();
    RUNNING_RELOCATIONS.add(request.operationId);
    let prepared: PreparedRelocationWorkspace | undefined;
    try {
      const target = JSON.parse(record.to_json) as Destination;
      const before = JSON.parse(record.from_json) as Before;
      prepared = await prepareWorkspaceForRelocation({
        sessionId: before.binding.sessionId, operationId: request.operationId, butlerData: this.input.butlerData,
        projectPath: target.project?.workspace_path ?? null, projectName: target.project?.display_name,
        onPrepared: workspace => this.input.db.query("UPDATE app_session_relocations SET prepared_json=? WHERE operation_id=?")
          .run(JSON.stringify(workspace), request.operationId),
      });
      this.input.db.query("UPDATE app_session_relocations SET phase='prepared',prepared_json=? WHERE operation_id=?")
        .run(JSON.stringify(prepared), request.operationId);
      const metadata = { ...before.binding.metadata, sessionWorkspace: prepared.marker ?? undefined,
        appSessionKind: target.project ? "project" : "chat", contextRevision: request.operationId };
      const changed = this.input.bindings.compareAndSetExecutionContext({
        sessionId: before.binding.sessionId, expectedUpdatedAt: before.binding.updatedAt,
        operationId: request.operationId, workspacePath: prepared.workspacePath,
        projectId: target.project?.id ?? null, appProjectId: target.project?.id ?? null,
        ledgerProjectId: target.project?.ledger_project_id ?? null, metadata,
      });
      if (changed.status !== "applied") spaceError("session_context_changed", "대화의 실행 환경이 변경되어 이동하지 못했습니다.");
      this.input.db.query("UPDATE app_session_relocations SET phase='bound' WHERE operation_id=?").run(request.operationId);
      this.finish(this.row(request.operationId)!);
      return { space: this.input.space.read() };
    } catch (error) {
      const current = this.row(request.operationId)!;
      const before = JSON.parse(current.from_json) as Before;
      if (this.input.bindings.getBySessionId(before.binding.sessionId)?.metadata?.relocationId !== request.operationId) {
        this.abort(current);
      }
      throw error;
    } finally { RUNNING_RELOCATIONS.delete(request.operationId); }
  }

  /** Startup and admission call the same synchronous forward-recovery path. */
  recoverPending(): void {
    const rows = this.input.db.query<Row, []>("SELECT * FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') OR (phase='aborted' AND prepared_json IS NOT NULL)").all();
    for (const row of rows) {
      if (RUNNING_RELOCATIONS.has(row.operation_id)) continue;
      try { this.recover(row); } catch {
        // One conflicting session remains gated; it cannot prevent other sessions from opening.
        this.input.db.query("UPDATE app_session_relocations SET error_code='session_context_conflict' WHERE operation_id=?").run(row.operation_id);
      }
    }
  }

  private reserve(request: RelocateSessionRequest): Row {
    const view = this.input.space.read();
    if (view.revision !== request.expectedRevision) spaceError("space_changed", "목록이 변경되었습니다. 다시 이동해 주세요.");
    const source = requireSpaceNode(view, `s:${request.sessionId}`);
    const session = this.input.getSession(request.sessionId);
    if (session.archived || request.sessionId === "general") spaceError("session_not_movable", "이 대화는 이동할 수 없습니다.");
    const target = request.targetKey ? requireSpaceNode(view, request.targetKey) : null;
    if (!target && request.position !== "inside") spaceError("space_invalid_target", "이동 위치가 필요합니다.");
    if (target?.key === source.key) spaceError("space_invalid_target", "다른 이동 위치를 선택해 주세요.");
    const parentKey = request.position === "inside" ? request.targetKey : target!.parentKey;
    const projectId = containerScope(view, parentKey);
    const project = projectId ? this.input.getProject(projectId) : null;
    if (projectId && (!project || project.archived)) spaceError("project_unavailable", "사용 가능한 프로젝트를 선택해 주세요.");
    if (projectId === source.scopeProjectId) spaceError("same_session_context", "같은 프로젝트 안에서는 목록 이동을 사용해 주세요.");
    const runtimeSessionId = sessionHintForRow(request.sessionId);
    this.gate.claimRelocation(request.sessionId, request.operationId,
      this.input.observer.hasUnfinishedExecution(runtimeSessionId) || this.hasOpenChild(runtimeSessionId));
    const binding = this.ensureBinding(session);
    const before: Before = { binding, parentKey: source.parentKey, projectId: source.scopeProjectId, ownerPid: process.pid };
    const to: Destination = { project, parentKey, targetKey: request.targetKey, position: request.position };
    this.input.db.query("INSERT INTO app_session_relocations VALUES(?,?,'preparing',?,?,NULL,NULL)")
      .run(request.operationId, request.sessionId, JSON.stringify(before), JSON.stringify(to));
    return this.row(request.operationId)!;
  }

  private ensureBinding(session: SessionSummary): StoredSessionBinding {
    const sessionId = sessionHintForRow(session.id);
    const existing = this.input.bindings.getBySessionId(sessionId);
    if (existing) return existing;
    const settings = this.input.getSettings();
    if (!settings.model.includes("/")) spaceError("model_not_configured", "먼저 사용할 모델을 설정해 주세요.");
    const project = session.project_id ? this.input.getProject(session.project_id) : null;
    return this.input.bindings.upsert({ sessionId, role: "butler", workspacePath: project?.workspace_path ?? this.input.butlerData,
      projectId: project?.id, appProjectId: project?.id, ledgerProjectId: project?.ledger_project_id ?? undefined,
      runtimeAdapterId: "btcc-turn-runtime", modelProviderId: settings.model.split("/")[0]!, modelRef: settings.model as `${string}/${string}`,
      lifecycleState: "active", transportBindings: [], metadata: { appSessionKind: session.kind, source: "app-session-relocation" } });
  }

  private hasOpenChild(sessionId: string, seen = new Set<string>()): boolean {
    if (seen.has(sessionId)) return true;
    seen.add(sessionId);
    return this.input.observer.relationsForParent(sessionId).some(relation => {
      const snapshot = this.input.observer.snapshot(relation.child_session_id);
      return !snapshot?.result || snapshot.waiting_for_children === true || this.hasOpenChild(relation.child_session_id, seen);
    });
  }

  private recover(row: Row): void {
    if (row.phase === "committed") return;
    if (row.phase === "aborted") { this.cleanup(row); return; }
    const before = JSON.parse(row.from_json) as Before;
    if (before.ownerPid !== process.pid) {
      try { process.kill(before.ownerPid, 0); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      }
    }
    const binding = this.input.bindings.getBySessionId(before.binding.sessionId);
    if (binding?.metadata?.relocationId === row.operation_id) { this.finish(row); return; }
    if (row.phase === "preparing" || binding?.updatedAt === before.binding.updatedAt) { this.abort(row); return; }
    spaceError("session_context_conflict", "대화 이동의 실행 환경을 확인해야 합니다. 기존 작업은 보존되어 있습니다.");
  }

  private finish(row: Row): void {
    if (!row.prepared_json) spaceError("relocation_preparation_missing", "이동 준비 정보를 확인할 수 없습니다.");
    const target = JSON.parse(row.to_json) as Destination;
    const before = JSON.parse(row.from_json) as Before;
    const conversations = new AgentConversationStore({ butlerData: this.input.butlerData });
    try {
      const canonical = conversations.getSessionByGatewayBinding("app", before.binding.sessionId);
      if (canonical) conversations.syncSessionContext({ sessionId: canonical.id, projectId: target.project?.id ?? null, revision: row.operation_id });
    } finally { conversations.close(); }
    this.input.db.transaction(() => {
      this.input.db.query("UPDATE app_session_relocations SET phase='committed' WHERE operation_id=?").run(row.operation_id);
      this.input.db.query("UPDATE chats SET kind=?,project_id=?,updated_at=? WHERE id=?")
        .run(target.project ? "project" : "chat", target.project?.id ?? null, new Date().toISOString(), row.session_id);
      const view = this.input.space.placeRelocatedSession(row.session_id, target.targetKey, target.position);
      this.gate.releaseRelocation(row.session_id, row.operation_id);
      this.input.appendEvent("session.updated", { session: this.input.getSession(row.session_id), context_revision: row.operation_id });
      this.input.appendEvent("space.changed", { revision: view.revision });
    })();
  }

  private abort(row: Row): void {
    this.input.db.transaction(() => {
      this.input.db.query("UPDATE app_session_relocations SET phase='aborted',error_code='relocation_not_applied' WHERE operation_id=?").run(row.operation_id);
      this.gate.releaseRelocation(row.session_id, row.operation_id);
    })();
    this.cleanup(this.row(row.operation_id)!);
  }

  private cleanup(row: Row): void {
    if (!row.prepared_json || CLEANING_RELOCATIONS.has(row.operation_id)) return;
    CLEANING_RELOCATIONS.add(row.operation_id);
    void discardRelocationWorkspace(JSON.parse(row.prepared_json) as PreparedRelocationWorkspace)
      .then(removed => {
        if (removed) this.input.db.query("UPDATE app_session_relocations SET prepared_json=NULL WHERE operation_id=? AND phase='aborted'").run(row.operation_id);
      })
      // Dirty worktrees or shutdown keep the ownership record for a later safe
      // recovery; cleanup never holds the conversation's execution gate.
      .catch(() => {})
      .finally(() => CLEANING_RELOCATIONS.delete(row.operation_id));
  }

  private row(id: string): Row | null {
    return this.input.db.query<Row, [string]>("SELECT * FROM app_session_relocations WHERE operation_id=?").get(id);
  }
}
