import type {
  ArchiveListView,
  ChatKind,
  ChatSummary,
  CommandPaletteView,
  CreateProjectRequest,
  CreateProjectResult,
  CreateSessionRequest,
  CreateSessionResult,
  NavigationView,
  NewChatBriefingView,
  ProjectActionResult,
  ProjectDashboardView,
  ProjectListView,
  ProjectSessionListView,
  SessionActionResult,
  SessionListView,
  SessionSummary,
  UpdateProjectRequest,
  UpdateSessionRequest,
} from "../../interface/protocol/app-protocol.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";
import type { SpaceCommand, SpaceMutationResult } from "../../interface/protocol/space-contract.ts";
import type { RelocateSessionRequest } from "../../domain/sessions/session-relocation.ts";
import { AppSessionContextGate } from "../../domain/sessions/session-context-gate.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

export interface AppStoreNavigationProjectApi {
  branchSession(request: import("../../../../foundation/session-branch.ts").SessionBranchRequest, signal?: AbortSignal): Promise<import("../../domain/sessions/session-branch-store.ts").SessionBranchResult>;
  getSessionBranchSeed(sessionId: string): import("../../../../foundation/session-branch.ts").SessionBranchSeed | undefined;
  branchSessionFromTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<import("../../domain/sessions/session-branch-store.ts").SessionBranchResult>;
  getBranchSource(sessionId: string): { view: import("../../interface/protocol/app-protocol.ts").SessionView; messageId: string };
  mutateSpace(command: SpaceCommand): SpaceMutationResult;
  relocateSession(request: RelocateSessionRequest): Promise<SpaceMutationResult>;
  assertSessionContextAdmission(sessionId: string, turnId: string): void;
  listChats(): ChatSummary[];
  listNavigation(): NavigationView;
  getNewChatBriefing(options?: {
    date?: string | null;
    projectId?: string | null;
  }): Promise<NewChatBriefingView>;
  listProjects(options?: { includeSessions?: boolean }): ProjectListView;
  createProject(input: CreateProjectRequest): CreateProjectResult;
  updateProject(
    projectId: string,
    input: UpdateProjectRequest,
  ): ProjectActionResult;
  archiveProject(
    projectId: string,
    metadata?: { displayName?: string; pinned?: boolean },
  ): ProjectActionResult;
  pinProject(projectId: string, pinned?: boolean): ProjectActionResult;
  deleteProject(projectId: string): ProjectActionResult;
  deleteProjectPermanent(projectId: string): ProjectActionResult;
  getProjectDashboard(projectId: string): Promise<ProjectDashboardView>;
  getProjectDashboardBoard: AppStoreKernel["projectDashboard"]["getBoard"];
  requestProjectDashboardBriefing: AppStoreKernel["projectDashboard"]["briefing"]["request"];
  getProjectDashboardStatistics: AppStoreKernel["projectDashboard"]["getStatistics"];
  getProjectDashboardMaterials: AppStoreKernel["projectDashboard"]["sources"]["list"];
  getProjectDashboardSource: AppStoreKernel["projectDashboard"]["sources"]["read"];
  getProjectDashboardHistory: AppStoreKernel["projectDashboard"]["sources"]["history"];
  getProjectDashboardArtifacts: AppStoreKernel["sessionRecords"]["listProjectArtifacts"];
  updateProjectDashboardPreferences: AppStoreKernel["projects"]["updateDashboardPreferences"];
  listSessions(options?: { kind?: ChatKind; projectId?: string }): SessionListView;
  listArchives(options?: { limit?: number; offset?: number }): ArchiveListView;
  listProjectSessions(projectId?: string): ProjectSessionListView;
  projectSessionIdsForLifecycle(projectId: string): string[];
  searchCommandPalette(query: string): CommandPaletteView;
  createSession(
    input: CreateSessionRequest,
    options?: { emitCreated?: boolean },
  ): CreateSessionResult;
  publishSessionCreated(sessionId: string): void;
  rollbackSessionCreation(sessionId: string): void;
  provisionProjectSessionWorktree(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  updateSession(
    sessionId: string,
    input: UpdateSessionRequest,
  ): SessionActionResult;
  archiveSession(
    sessionId: string,
    metadata?: { title?: string },
  ): SessionActionResult;
  deleteSessionPermanent(sessionId: string): SessionActionResult;
  getSession(sessionId: string): SessionSummary;
}

export function createNavigationProjectStoreApi(
  kernel: AppStoreKernel,
): AppStoreNavigationProjectApi {
  return {
    branchSession: (request, signal) => kernel.sessionBranches.branch(request, signal),
    branchSessionFromTool: (args, signal) => kernel.sessionBranches.fromTool(args, signal),
    getSessionBranchSeed: sessionId => kernel.sessionBranches.seed(sessionId),
    assertSessionContextAdmission(sessionId, turnId) {
      kernel.sessionRelocation.recoverPending();
      const turn = kernel.turns.getTurnRow(turnId);
      const gate = new AppSessionContextGate(kernel.db);
      gate.assertNotRelocating(sessionId);
      if (!turn || turn.chat_id !== sessionId || gate.owner(sessionId)?.owner_id !== turnId) {
        throw new AppStoreOperationError(409, "session_context_admission_mismatch", "대화의 실행 문맥이 변경되었습니다.");
      }
    },
    relocateSession(request) {
      return kernel.sessionRelocation.relocate(request);
    },
    mutateSpace(command) {
      return kernel.space.execute(command);
    },
    getBranchSource(sessionId) {
      kernel.sessionRecords.getSession(sessionId);
      const seed = kernel.sessionBranches.seed(sessionId);
      const source = seed && kernel.sessionRecords.getMessageRow(seed.sourceMessageId);
      if (!source || !seed || source.chat_id !== seed.sourceSessionId) {
        throw new AppStoreOperationError(404, "branch_source_unavailable", "원본 답변이 삭제되어 열 수 없습니다.");
      }
      return { messageId: seed.sourceMessageId, view: kernel.sessionViews.getSessionView(seed.sourceSessionId,
        { beforeCursor: source.rowid + 1, limit: 30 }) };
    },
    listChats() {
      return kernel.sessionCatalog.listChats();
    },
    listNavigation() {
      return kernel.navigation.listNavigation();
    },
    getNewChatBriefing(options = {}) {
      return kernel.newChatBriefing.get(options);
    },
    listProjects(options = {}) {
      return kernel.projects.listProjects(options);
    },
    createProject(input) {
      return kernel.projects.createProject(input);
    },
    updateProject(projectId, input) {
      return kernel.projects.updateProject(projectId, input);
    },
    archiveProject(projectId, metadata) {
      return kernel.projects.archiveProject(projectId, metadata);
    },
    pinProject(projectId, pinned) {
      return kernel.projects.pinProject(projectId, pinned);
    },
    deleteProject(projectId) {
      return kernel.projects.deleteProject(projectId);
    },
    deleteProjectPermanent(projectId) {
      return kernel.projects.deleteProjectPermanent(projectId);
    },
    getProjectDashboard(projectId) {
      return kernel.projectDashboard.getProjectDashboard(projectId);
    },
    getProjectDashboardArtifacts(projectId, query) {
      if (!kernel.getProjectRow(projectId)) throw new AppStoreOperationError(404, "project_not_found", "Project not found.");
      return kernel.sessionRecords.listProjectArtifacts(projectId, query);
    },
    getProjectDashboardBoard(projectId, query) {
      return kernel.projectDashboard.getBoard(projectId, query);
    },
    requestProjectDashboardBriefing(projectId, revision, retry) {
      return kernel.projectDashboard.briefing.request(projectId, revision, retry);
    },
    getProjectDashboardStatistics(projectId, days, timezone) {
      return kernel.projectDashboard.getStatistics(projectId, days, timezone);
    },
    getProjectDashboardMaterials(projectId, query) {
      return kernel.projectDashboard.sources.list(projectId, query);
    },
    getProjectDashboardSource(projectId, query) {
      return kernel.projectDashboard.sources.read(projectId, query);
    },
    getProjectDashboardHistory(projectId, query) {
      return kernel.projectDashboard.sources.history(projectId, query);
    },
    updateProjectDashboardPreferences(projectId, patch) {
      return kernel.projects.updateDashboardPreferences(projectId, patch);
    },
    listSessions(options = {}) {
      return kernel.sessionCatalog.listSessions(options);
    },
    listArchives(options = {}) {
      return kernel.sessionCatalog.listArchives(options);
    },
    listProjectSessions(projectId) {
      return kernel.sessionCatalog.listProjectSessions(projectId);
    },
    projectSessionIdsForLifecycle(projectId) {
      return kernel.sessionCatalog.projectSessionIdsForLifecycle(projectId);
    },
    searchCommandPalette(query) {
      return kernel.navigation.searchCommandPalette(query);
    },
    createSession(input, options) {
      return kernel.sessionRecords.createSession(input, options);
    },
    publishSessionCreated(sessionId) {
      kernel.sessionRecords.publishSessionCreated(sessionId);
    },
    rollbackSessionCreation(sessionId) {
      kernel.sessionRecords.rollbackSessionCreation(sessionId);
    },
    async provisionProjectSessionWorktree(sessionId, signal) {
      await kernel.projectSessionWorktrees.provision(sessionId, signal);
    },
    updateSession(sessionId, input) {
      return kernel.sessionRecords.updateSession(sessionId, input);
    },
    archiveSession(sessionId, metadata) {
      return kernel.sessionRecords.updateSession(sessionId, {
        archived: true,
        title: metadata?.title,
      });
    },
    deleteSessionPermanent(sessionId) {
      return kernel.sessionRecords.deleteSessionPermanent(sessionId);
    },
    getSession(sessionId) {
      return kernel.sessionRecords.getSession(sessionId);
    },
  };
}
