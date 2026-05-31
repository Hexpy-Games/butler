import { useState } from "react";
import { useButlerStore } from "@/app/store.ts";
import { useProjectDashboard } from "@/hooks/useProjectDashboard.ts";
import { Stack } from "@/butler-ds";
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
  const openNewProjectChat = useButlerStore(
    (state) => state.openNewProjectChat,
  );
  const startProjectChatWithDocument = useButlerStore(
    (state) => state.startProjectChatWithDocument,
  );
  const { dashboard, project, sessions } = useProjectDashboard({
    initialDashboard,
    project: projectProp,
  });
  const [selectedDocument, setSelectedDocument] =
    useState<ProjectDashboardDocument | null>(null);
  const days = dashboard?.activity.days ?? [];

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
