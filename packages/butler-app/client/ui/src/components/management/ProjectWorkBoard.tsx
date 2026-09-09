import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { useButlerStore } from "@/app/store.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { planLanes } from "@/app/projectDocuments.ts";
import { useProjectBoard } from "@/hooks/useProjectBoard.ts";
import { Button, Notice, Section, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Stack, Tabs, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import { ProjectBoardCard } from "./ProjectBoardCard.tsx";
import styles from "./ProjectWorkBoard.module.css";
import type { ProjectDashboardDocument } from "@/app/types.ts";

export function ProjectWorkBoard({ projectId, onOpenSession, onSelect, revision }: {
  projectId: string; onOpenSession: (id: string) => void;
  revision?: string;
  onSelect: (document: ProjectDashboardDocument) => void;
}) {
  useAppLocale();
  const disconnected = useButlerStore((state) => state.liveConnectionLost);
  const kind = useProjectDashboardState((state) => state.projects[projectId]?.boardKind ?? "work");
  const parent = useProjectDashboardState((state) => state.projects[projectId]?.boardParent);
  const update = useProjectDashboardState((state) => state.update);
  const { page, loading, error, retry, loadMore } = useProjectBoard(projectId, kind, kind === "work" ? undefined : parent, revision);
  const copy = appCopy.projectSignpost;
  const lanes = [...planLanes().slice(0, 2).map((lane) => kind === "plan" && lane.id === "active" ? { ...lane, label: copy.currentPlan } : lane), { id: "review", label: appCopy.interfaceStatus.review },
    { id: "blocked", label: copy.blocked }, ...planLanes().slice(2)] as const;
  return <Stack gap="lg">
    {disconnected && <Typo.Caption role="status">{copy.disconnected}</Typo.Caption>}
    <Tabs value={kind} onValueChange={(value) => update(projectId, { boardKind: value as typeof kind })}>
      <TabsList>
        <TabsTrigger value="work">{appCopy.interfaceStatus.work}</TabsTrigger>
        <TabsTrigger value="plan">{appCopy.composer.plan}</TabsTrigger>
        <TabsTrigger value="task">{appCopy.interfaceStatus.task}</TabsTrigger>
      </TabsList>
    </Tabs>
    {kind !== "work" && page?.status === "ready" && <Select value={parent ?? "all"}
      onValueChange={(value) => update(projectId, { boardParent: value === "all" ? undefined : value })}>
      <SelectTrigger aria-label={copy.parentWork}><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="all">{copy.allWork}</SelectItem>
        {page.parents.map((work) => <SelectItem key={work.id} value={work.id}>{work.title}</SelectItem>)}
      </SelectContent>
    </Select>}
    {error && <Notice tone="error" message={appCopy.feedback.dashboardRetry}
      action={<Button variant="outline" onClick={retry}>{appCopy.feedback.retry}</Button>} />}
    {page?.status === "unavailable" && <Typo.Body>{page.reason === "unbound" ? copy.unbound : copy.unavailable}</Typo.Body>}
    {loading && !page && <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>}
    {page?.status === "ready" && <>
      <Typo.Body>{copy.loaded(page.items.length, page.total)}</Typo.Body>
      <div className={styles.board} data-test-class="project-work-board">
        {lanes.map((lane) => <Section key={lane.id} className={styles.lane} title={`${lane.label} · ${page.laneCounts[lane.id]}`}>
          {page.items.filter((card) => card.lane === lane.id).map((card) => <ProjectBoardCard key={card.id} card={card}
            running={Boolean(card.session?.running && !disconnected)} onOpen={() => onSelect({ id: card.id, project_id: projectId,
              revision: page.sourceRevision, kind: "plan", document_type: card.kind, title: card.title,
              markdown: "", safe_path_label: card.id, updated_at: card.updatedAt })}
            onOpenSession={() => { if (card.session) onOpenSession(card.session.id); }} />)}
          <Typo.Caption>{copy.loaded(page.items.filter((card) => card.lane === lane.id).length, page.laneCounts[lane.id])}</Typo.Caption>
        </Section>)}
      </div>
      {page.total === 0 && <Typo.Body>{copy.noWork}</Typo.Body>}
      {page.nextCursor && <Button variant="borderless" disabled={loading} onClick={loadMore}>{copy.loadMore}</Button>}
    </>}
  </Stack>;
}
