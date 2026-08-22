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

export interface AppStoreNavigationProjectApi {
  listChats(): ChatSummary[];
  listNavigation(): NavigationView;
  getNewChatBriefing(options?: {
    date?: string | null;
    projectId?: string | null;
  }): NewChatBriefingView;
  listProjects(options?: { includeSessions?: boolean }): ProjectListView;
  createProject(input: CreateProjectRequest): CreateProjectResult;
  updateProject(
    projectId: string,
    input: UpdateProjectRequest,
  ): ProjectActionResult;
  archiveProject(projectId: string): ProjectActionResult;
  pinProject(projectId: string, pinned?: boolean): ProjectActionResult;
  deleteProject(projectId: string): ProjectActionResult;
  deleteProjectPermanent(projectId: string): ProjectActionResult;
  getProjectDashboard(projectId: string): ProjectDashboardView;
  listSessions(options?: { kind?: ChatKind; projectId?: string }): SessionListView;
  listArchives(options?: { limit?: number; offset?: number }): ArchiveListView;
  listProjectSessions(projectId?: string): ProjectSessionListView;
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
  archiveSession(sessionId: string): SessionActionResult;
  deleteSessionPermanent(sessionId: string): SessionActionResult;
  getSession(sessionId: string): SessionSummary;
}

export function createNavigationProjectStoreApi(
  kernel: AppStoreKernel,
): AppStoreNavigationProjectApi {
  return {
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
    archiveProject(projectId) {
      return kernel.projects.archiveProject(projectId);
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
    listSessions(options = {}) {
      return kernel.sessionCatalog.listSessions(options);
    },
    listArchives(options = {}) {
      return kernel.sessionCatalog.listArchives(options);
    },
    listProjectSessions(projectId) {
      return kernel.sessionCatalog.listProjectSessions(projectId);
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
    archiveSession(sessionId) {
      return kernel.sessionRecords.updateSession(sessionId, {
        archived: true,
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
