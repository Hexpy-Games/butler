import type { ProjectRow } from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from
  "../../infrastructure/core/app-store-errors.ts";
import type { SettingsView, SessionSummary } from
  "../../interface/protocol/app-protocol.ts";
import {
  bindSessionGitWorktree,
  createWorkspaceReference,
  shortSessionWorktreeBranch,
} from "../../../../agent/session-workspaces/index.ts";
import type { AppSessionWorkspaceBindingStore } from
  "./session-workspace-binding-store.ts";
import { sessionHintForRow } from "./session-read-model.ts";

export class AppProjectSessionWorktreeProvisioner {
  constructor(
    private readonly input: {
      butlerData: string;
      bindings: AppSessionWorkspaceBindingStore;
      getSession(sessionId: string): SessionSummary;
      getProject(projectId: string): ProjectRow | null;
      getSettings(): SettingsView;
    },
  ) {}

  async provision(sessionId: string, signal?: AbortSignal, branchRequestId?: string): Promise<void> {
    const session = this.input.getSession(sessionId);
    if (session.kind !== "project" || !session.project_id) return;
    const project = this.input.getProject(session.project_id);
    if (!project) {
      throw provisioningError();
    }
    const runtimeSessionId = sessionHintForRow(session.id);
    const existing = this.input.bindings.getBySessionId(runtimeSessionId);
    if (existing && (!branchRequestId || existing.metadata?.branchRequestId !== branchRequestId || existing.appProjectId !== session.project_id)) {
      throw provisioningError();
    }
    const settings = this.input.getSettings();
    if (!settings.model.includes("/")) throw provisioningError();
    const modelRef = settings.model as `${string}/${string}`;
    if (!existing) this.input.bindings.upsert({
      sessionId: runtimeSessionId,
      role: "butler",
      projectId: session.project_id,
      appProjectId: session.project_id,
      ledgerProjectId: project.ledger_project_id ?? undefined,
      workspacePath: project.workspace_path,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: modelRef.split("/", 1)[0] || "openai",
      modelRef,
      lifecycleState: "active",
      transportBindings: [],
      metadata: {
        ...(branchRequestId ? { branchRequestId } : {}),
        source: "app-project-session-creation",
        appSessionKind: "project",
        accessMode: settings.access_mode,
        reasoning_effort: settings.reasoning_effort,
        plan_mode: settings.plan_mode_default,
      },
    });
    const branch = shortSessionWorktreeBranch(session.id);
    const result = await bindSessionGitWorktree({
      action: "create",
      branch,
      startPoint: "HEAD",
      sessionId: runtimeSessionId,
      projectName: project.display_name,
      butlerData: this.input.butlerData,
      bindingStore: this.input.bindings,
      workspaceReference: createWorkspaceReference(project.workspace_path),
      signal,
    });
    if (result.ok) return;
    this.input.bindings.deleteSession(runtimeSessionId);
    if (
      result.error.code === "git_not_installed" ||
      result.error.code === "git_repository_required"
    ) {
      return;
    }
    throw provisioningError();
  }
}

function provisioningError(): AppStoreOperationError {
  return new AppStoreOperationError(
    409,
    "session_worktree_creation_failed",
    "Project session worktree could not be created.",
  );
}
