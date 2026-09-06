import { useState } from "react";
import { useButlerStore } from "@/app/store.ts";
import { useProjectDashboard } from "@/hooks/useProjectDashboard.ts";
import { Stack, Notice, Button } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { ManagementPage } from "@/butler-ds";
import type {
  ProjectDashboardDocument,
  ProjectDashboardView as ProjectDashboardData,
  ProjectSummary,
} from "@/app/types.ts";
import { ProjectActivityPanel } from "./ProjectActivityPanel.tsx";
import { ProjectDashboardHeader } from "./ProjectDashboardHeader.tsx";
import { ProjectDocumentDialog } from "./ProjectDocumentDialog.tsx";
import { ProjectDocumentsPanel } from "./ProjectDocumentsPanel.tsx";
import { ProjectSessionsPanel } from "./ProjectSessionsPanel.tsx";
import { ProjectStatsGrid } from "./ProjectStatsGrid.tsx";

export function ProjectDashboardView({
  project: projectProp,
  initialDashboard,
  onOpenSession,
  onNewProjectChat,
}: {
  project?: ProjectSummary;
  initialDashboard?: ProjectDashboardData | null;
  onOpenSession?: (sessionId: string) => void;
  onNewProjectChat?: (projectId: string) => void;
} = {}) {
  const openSession = useButlerStore((state) => state.openSession);
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const openNewProjectChat = useButlerStore(
    (state) => state.openNewProjectChat,
  );
  const startProjectChatWithDocument = useButlerStore(
    (state) => state.startProjectChatWithDocument,
  );
  const { dashboard, project, sessions, status, retry } = useProjectDashboard({
    initialDashboard,
    project: projectProp,
  });
  const [selectedDocument, setSelectedDocument] =
    useState<ProjectDashboardDocument | null>(null);
  const days = dashboard?.activity.days ?? [];

  if (status !== "ready") {
    const copy = appCopy.feedback;
    return (
      <ManagementPage dataTestClass="project-dashboard-view">
        <div role="status" aria-live="polite" data-test-class="project-dashboard-status">
          <Notice tone={status === "error" ? "error" : "info"}
            title={status === "error" ? copy.dashboardFailed : status === "missing" ? copy.projectMissing : undefined}
            message={status === "loading" ? copy.dashboardLoading : status === "missing" ? copy.projectMissingHelp : copy.dashboardRetry}
            action={status === "loading" ? undefined : (
              <Button variant="outline" onClick={status === "missing" ? openNewChat : retry}>
                {status === "missing" ? copy.newChat : copy.retry}
              </Button>
            )} />
        </div>
      </ManagementPage>
    );
  }

  return (
    <ManagementPage dataTestClass="project-dashboard-view">
      <Stack as="main" gap="xl">
        <ProjectDashboardHeader
          dashboard={dashboard}
          project={project}
          sessionsCount={sessions.length}
          onNewProjectChat={onNewProjectChat ?? openNewProjectChat}
        />
        <ProjectStatsGrid
          dashboard={dashboard}
          sessionsCount={sessions.length}
        />
        <ProjectActivityPanel days={days} />
        <ProjectDocumentsPanel
          documents={dashboard?.documents ?? []}
          onSelectDocument={setSelectedDocument}
        />
        <ProjectSessionsPanel
          sessions={sessions}
          onOpenSession={onOpenSession ?? openSession}
        />
      </Stack>
      <ProjectDocumentDialog
        document={selectedDocument}
        onClose={() => setSelectedDocument(null)}
        onStartChatWithDocument={(document) => {
          if (!project?.id) return;
          setSelectedDocument(null);
          startProjectChatWithDocument(project.id, document);
        }}
      />
    </ManagementPage>
  );
}
