import { Database } from "bun:sqlite";
import { readProjectFolderSelectionToken } from "./project-folder-selection-token.ts";
import {
  projectFromRow,
  safeDisplayName,
  safeLocalSessionId,
  safeWorkspaceLabel,
} from "../sessions/session-read-model.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { AppProjectFolderStore } from "../projects/project-folder-store.ts";
import type {
  CreateProjectRequest,
  CreateProjectResult,
  ProjectActionResult,
  ProjectListView,
  SessionSummary,
  UpdateProjectRequest,
} from "../../interface/protocol/app-protocol.ts";

export class AppProjectStore {
  constructor(
    private readonly db: Database,
    private readonly folders: AppProjectFolderStore,
    private readonly folderSelectionSecret: string | undefined,
    private readonly projectSessions: () => SessionSummary[],
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  listProjects(options: { includeSessions?: boolean } = {}): ProjectListView {
    const rows = this.db
      .query<ProjectRow, []>(
        `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE archived = 0
      ORDER BY pinned DESC, updated_at DESC, display_name ASC
    `,
      )
      .all();
    const sessions = options.includeSessions ? this.projectSessions() : [];
    const sessionsByProject = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      if (!session.project_id) continue;
      const bucket = sessionsByProject.get(session.project_id) ?? [];
      bucket.push(session);
      sessionsByProject.set(session.project_id, bucket);
    }
    return {
      projects: rows.map((row) =>
        projectFromRow(
          row,
          options.includeSessions
            ? (sessionsByProject.get(row.id) ?? [])
            : undefined,
        ),
      ),
    };
  }

  createProject(input: CreateProjectRequest): CreateProjectResult {
    const workspacePath = this.workspacePathForCreate(input);
    const existing = this.getProjectRowByWorkspacePath(workspacePath);
    if (existing) return { project: projectFromRow(existing) };

    const now = new Date().toISOString();
    const workspaceLabel = safeWorkspaceLabel(workspacePath);
    const displayName = safeDisplayName(input.display_name, workspaceLabel);
    const projectId = this.nextProjectId(displayName);
    this.db
      .query(
        `
      INSERT INTO projects (
        id, display_name, status, workspace_path, workspace_label, safe_path_label,
        ledger_project_id,
        pinned, archived, error_summary, created_at, updated_at
      )
      VALUES (?, ?, 'active', ?, ?, ?, ?, 0, 0, NULL, ?, ?)
    `,
      )
      .run(
        projectId,
        displayName,
        workspacePath,
        workspaceLabel,
        workspaceLabel,
        projectId,
        now,
        now,
      );
    const row = this.getProjectRow(projectId);
    if (!row) throw new Error(`Failed to create project: ${projectId}`);
    const project = projectFromRow(row);
    this.appendEvent("project.created", { project });
    return { project };
  }

  updateProject(
    projectId: string,
    input: UpdateProjectRequest,
  ): ProjectActionResult {
    const row = this.getProjectRowAnyStatus(projectId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    }
    const displayName = input.display_name?.trim();
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE projects
      SET display_name = ?, pinned = ?, archived = ?, status = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        displayName || row.display_name,
        input.pinned === undefined ? row.pinned : input.pinned ? 1 : 0,
        input.archived === undefined ? row.archived : input.archived ? 1 : 0,
        input.archived === undefined
          ? row.status
          : input.archived
            ? "archived"
            : "active",
        now,
        projectId,
      );
    const project = projectFromRow(this.getProjectRowAnyStatus(projectId)!);
    this.appendEvent("project.updated", { project });
    return { project };
  }

  archiveProject(projectId: string): ProjectActionResult {
    const result = this.updateProject(projectId, { archived: true });
    this.db
      .query(
        `
      UPDATE chats
      SET archived = 1, updated_at = ?
      WHERE project_id = ?
    `,
      )
      .run(new Date().toISOString(), projectId);
    return result;
  }

  pinProject(projectId: string, pinned?: boolean): ProjectActionResult {
    const row = this.getProjectRow(projectId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    }
    return this.updateProject(projectId, {
      pinned: pinned ?? row.pinned !== 1,
    });
  }

  deleteProject(projectId: string): ProjectActionResult {
    const result = this.archiveProject(projectId);
    this.appendEvent("project.deleted", { project: result.project });
    return result;
  }

  deleteProjectPermanent(projectId: string): ProjectActionResult {
    const row = this.getProjectRowAnyStatus(projectId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    }
    const project = projectFromRow(row);
    this.db.transaction(() => {
      this.db.query("DELETE FROM chats WHERE project_id = ?").run(projectId);
      this.db.query("DELETE FROM projects WHERE id = ?").run(projectId);
    })();
    this.appendEvent("project.permanently_deleted", { project });
    return { project };
  }

  getProjectRow(projectId: string): ProjectRow | null {
    return this.projectRow(projectId, "WHERE id = ? AND archived = 0");
  }

  getProjectRowAnyStatus(projectId: string): ProjectRow | null {
    return this.projectRow(projectId, "WHERE id = ?");
  }

  getProjectRowByWorkspacePath(workspacePath: string): ProjectRow | null {
    return this.projectRow(workspacePath, "WHERE workspace_path = ? AND archived = 0");
  }

  private workspacePathForCreate(input: CreateProjectRequest): string {
    if (input.source === "scratch") {
      return this.folders.createScratchProjectFolder();
    }
    if (!input.folder_selection_token?.trim()) {
      throw new AppStoreOperationError(
        400,
        "folder_selection_required",
        "Project folder selection is required.",
      );
    }
    const selectedPath = readProjectFolderSelectionToken(
      input.folder_selection_token,
      this.folderSelectionSecret,
    );
    return this.folders.validateProjectFolder(selectedPath);
  }

  private nextProjectId(displayName: string): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const suffix = crypto.randomUUID().slice(0, 8);
      const id = `project-${safeLocalSessionId(displayName)}-${suffix}`;
      if (!this.getProjectRow(id)) return id;
    }
    return `project-${crypto.randomUUID()}`;
  }

  private projectRow(value: string, predicate: string): ProjectRow | null {
    return (
      this.db
        .query<ProjectRow, [string]>(
          `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      ${predicate}
    `,
        )
        .get(value) ?? null
    );
  }
}
