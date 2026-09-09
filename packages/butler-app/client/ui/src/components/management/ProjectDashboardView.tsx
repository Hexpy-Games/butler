import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useRef, useState } from "react";
import { useButlerStore } from "@/app/store.ts";
import { useProjectDashboard } from "@/hooks/useProjectDashboard.ts";
import { Stack, Notice, Button, Tabs, TabsList, TabsTrigger, TabsContent, Section } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { ManagementPage } from "@/butler-ds";
import type {
  ProjectDashboardDocument,
  ProjectDashboardView as ProjectDashboardData,
  ProjectSummary,
} from "@/app/types.ts";
import { ProjectDashboardHeader } from "./ProjectDashboardHeader.tsx";
import { ProjectDocumentDialog } from "./ProjectDocumentDialog.tsx";
import { ProjectDashboardComposer } from "./ProjectDashboardComposer.tsx";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { useComposerStore } from "@/components/conversation/composerStore.ts";
import { ProjectStatisticsPanel } from "./ProjectStatisticsPanel.tsx";
import { ProjectOverviewPanel } from "./ProjectOverviewPanel.tsx";
import { ProjectWorkBoard } from "./ProjectWorkBoard.tsx";
import { ProjectMaterialsPanel } from "./ProjectMaterialsPanel.tsx";
import { readProjectDocumentPage } from "@/app/projectDocumentSource.ts";
import { notifyError } from "@/app/notifications.ts";
import { ProjectDescription } from "./ProjectDescription.tsx";
import { ProjectHistoryPanel } from "./ProjectHistoryPanel.tsx";
import { ProjectResultsPanel } from "./ProjectResultsPanel.tsx";
import { ProjectBriefingPanel } from "./ProjectBriefingPanel.tsx";
import styles from "./ProjectDashboardView.module.css";
import { useProjectArtifactAttachment } from "@/hooks/useProjectArtifactAttachment.ts";
import { useProjectDashboardScroll } from "@/hooks/useProjectDashboardScroll.ts";

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
  useAppLocale();
  const openSession = useButlerStore((state) => state.openSession);
  const openNewChat = useButlerStore((state) => state.openNewChat);
  const openNewProjectChat = useButlerStore(
    (state) => state.openNewProjectChat,
  );
  const { dashboard, project, sessions, status, retry, refreshFailed } = useProjectDashboard({
    initialDashboard,
    project: projectProp,
  });
  const [selectedDocument, setSelectedDocument] =
    useState<ProjectDashboardDocument | null>(null);
  const tab = useProjectDashboardState((state) => project ? state.projects[project.id]?.tab ?? "overview" : "overview");
  const scrollRef = useProjectDashboardScroll(project?.id, tab);
  const updateDashboardState = useProjectDashboardState((state) => state.update);
  const setTab = (tab: string) => { if (project) updateDashboardState(project.id, { tab }); };
  const selectionEpoch = useRef(0);
  const attachArtifact = useProjectArtifactAttachment(project?.id);
  const ledgerRevision = dashboard?.overview?.status === "ready" ? dashboard.overview.sourceRevision : "unavailable";
  const publicRevision = `${ledgerRevision}:${sessions.map((session) => `${session.id}:${session.last_activity_at}:${session.active_turn_state ?? ""}`).join("|")}`;
  useEffect(() => { selectionEpoch.current++; setSelectedDocument(null); }, [project?.id]);
  const selectDocument = (document: ProjectDashboardDocument) => {
    const epoch = ++selectionEpoch.current;
    void readProjectDocumentPage(document).then((source) => {
      if (selectionEpoch.current !== epoch) return;
      setSelectedDocument(source);
    }).catch((error) => { if (selectionEpoch.current === epoch) notifyError(error, appCopy.interfacePanels.projectDocumentsFailed); });
  };

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
    <ManagementPage dataTestClass="project-dashboard-view" scrollRef={scrollRef} footer={project && <ProjectDashboardComposer key={project.id} projectId={project.id} sessions={sessions} />}>
      <Stack as="main" gap="xl">
        {refreshFailed && <Notice tone="error" title={appCopy.feedback.dashboardFailed} message={appCopy.feedback.dashboardRetry}
          action={<Button variant="outline" onClick={retry}>{appCopy.feedback.retry}</Button>} />}
        <ProjectDashboardHeader
          dashboard={dashboard}
          project={project}
          sessionsCount={sessions.length}
          onNewProjectChat={onNewProjectChat ?? openNewProjectChat}
        />
        {project && <ProjectDescription key={project.id} projectId={project.id} description={dashboard?.description ?? null}
          revision={dashboard?.preferences?.revision ?? 0} onUpdated={retry} />}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList variant="line">
            <TabsTrigger value="overview">{appCopy.projectSignpost.overview}</TabsTrigger>
            <TabsTrigger value="work">{appCopy.projectSignpost.work}</TabsTrigger>
            <TabsTrigger value="materials">{appCopy.projectSignpost.materials}</TabsTrigger>
            <TabsTrigger value="history">{appCopy.projectSignpost.history}</TabsTrigger>
            <TabsTrigger value="statistics">{appCopy.projectSignpost.statistics}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><Stack gap="xl" className={styles.reading}>
            {project && <ProjectBriefingPanel key={project.id} projectId={project.id} briefing={dashboard?.briefing}
              onSelect={selectDocument} onUpdated={retry} />}
            <ProjectOverviewPanel overview={dashboard?.overview} projectId={project?.id} onSelect={selectDocument} onShowAll={() => setTab("work")} />
            {project && <Section title={appCopy.projectSignpost.materials} description={appCopy.projectSignpost.importantMaterialsHelp}>
              <ProjectMaterialsPanel key={`${project.id}:${ledgerRevision}:${dashboard?.preferences?.revision}`} projectId={project.id} onSelect={selectDocument} limit={5}
                preferences={dashboard?.preferences} onShowAll={() => setTab("materials")} />
            </Section>}
            {project && <ProjectBriefingPanel key={`${project.id}:suggestions`} section="suggestions" projectId={project.id} briefing={dashboard?.briefing}
              onSelect={selectDocument} onUpdated={retry} />}
          </Stack></TabsContent>
          <TabsContent value="statistics">{project && <ProjectStatisticsPanel projectId={project.id} revision={publicRevision} />}</TabsContent>
        <TabsContent value="work">{project && <ProjectWorkBoard projectId={project.id}
          revision={publicRevision}
          onSelect={selectDocument} onOpenSession={onOpenSession ?? openSession} />}</TabsContent>
        <TabsContent value="materials">{project && <Stack gap="xl"><ProjectMaterialsPanel key={`${project.id}:${ledgerRevision}:${dashboard?.preferences?.revision}`}
          projectId={project.id} onSelect={selectDocument} preferences={dashboard?.preferences} onUpdated={retry} />
          <ProjectResultsPanel key={`${project.id}:${publicRevision}`} projectId={project.id} preferences={dashboard?.preferences} onUpdated={retry} onSelect={selectDocument} /></Stack>}</TabsContent>
        <TabsContent value="history">{project && <ProjectHistoryPanel key={`${project.id}:${publicRevision}`} projectId={project.id} onSelect={selectDocument} onOpenSession={onOpenSession ?? openSession} />}</TabsContent>
        </Tabs>
      </Stack>
      <ProjectDocumentDialog
        document={selectedDocument}
        onClose={() => { selectionEpoch.current++; setSelectedDocument(null); }}
        onLoadMore={selectedDocument?.nextCursor ? () => {
          const current = selectedDocument;
          void readProjectDocumentPage(current, current.nextCursor!).then((next) =>
            setSelectedDocument((selected) => selected === current ? { ...next, markdown: current.markdown + next.markdown } : selected),
          ).catch((error) => notifyError(error, appCopy.interfacePanels.projectDocumentsFailed));
        } : undefined}
        onStartChatWithDocument={(document) => {
          if (!project?.id) return;
          setSelectedDocument(null);
          if (document.artifact && document.revision) { void attachArtifact({ id: document.id, revision: document.revision }); return; }
          const composer = useComposerStore.getState();
          if (!composer.text.trim()) composer.setText(appCopy.projectSignpost.sourceQuestion);
          void composer.addProjectDocument(document);
        }}
      />
    </ManagementPage>
  );
}
