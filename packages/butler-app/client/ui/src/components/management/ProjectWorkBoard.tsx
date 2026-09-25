import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { useButlerStore } from "@/app/store.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { planLanes } from "@/app/projectDocuments.ts";
import { useProjectBoard } from "@/hooks/useProjectBoard.ts";
import { Box, Button, Notice, Section, SegmentedControl, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Stack, Typo, useScrollEdges } from "@/butler-ds";
import { ProjectBoardCard } from "./ProjectBoardCard.tsx";
import styles from "./ProjectWorkBoard.module.css";
import type { ProjectDashboardDocument } from "@/app/types.ts";

export function ProjectWorkBoard({ projectId, onOpenSession, onSelect, revision }: {
  projectId: string; onOpenSession: (id: string) => void;
  revision?: string;
  onSelect: (document: ProjectDashboardDocument) => void;
}) {
  useAppLocale();
  const boardFadeRef = useScrollEdges("x");
  const disconnected = useButlerStore((state) => state.liveConnectionLost);
  const kind = useProjectDashboardState((state) => state.projects[projectId]?.boardKind ?? "work");
  const parent = useProjectDashboardState((state) => state.projects[projectId]?.boardParent);
  const update = useProjectDashboardState((state) => state.update);
  const parentId = kind === "work" ? undefined : parent;
  const boards = {
    planned: useProjectBoard(projectId, kind, parentId, revision, "planned"),
    active: useProjectBoard(projectId, kind, parentId, revision, "active"),
    review: useProjectBoard(projectId, kind, parentId, revision, "review"),
    blocked: useProjectBoard(projectId, kind, parentId, revision, "blocked"),
    done: useProjectBoard(projectId, kind, parentId, revision, "done"),
    other: useProjectBoard(projectId, kind, parentId, revision, "other"),
  };
  const { page, loading } = boards.planned;
  const error = Object.values(boards).some((board) => board.error);
  const retry = () => Object.values(boards).forEach((board) => board.retry());
  const copy = appCopy.projectSignpost;
  const lanes = [...planLanes().slice(0, 2).map((lane) => kind === "plan" && lane.id === "active" ? { ...lane, label: copy.currentPlan } : lane), { id: "review", label: appCopy.interfaceStatus.review },
    { id: "blocked", label: copy.blocked }, ...planLanes().slice(2)] as const;
  return <Stack gap="lg">
    {disconnected && <Typo.Caption role="status">{copy.disconnected}</Typo.Caption>}
    <SegmentedControl ariaLabel={copy.boardKind} value={kind}
      onValueChange={(value) => update(projectId, { boardKind: value as typeof kind })}
      options={[{ value: "work", label: appCopy.interfaceStatus.work }, { value: "plan", label: appCopy.composer.plan },
        { value: "task", label: appCopy.interfaceStatus.task }]} />
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
      <div ref={boardFadeRef} className={styles.board} data-test-class="project-work-board">
        {lanes.map((lane) => {
          const board = boards[lane.id];
          const lanePage = board.page?.status === "ready" ? board.page : null;
          return <Box key={lane.id} surface="base" border="hairline" radius="control" padding="md" alignSelf="start">
          <Section title={`${lane.label} · ${page.laneCounts[lane.id]}`}>
          {lanePage?.items.map((card) => <ProjectBoardCard key={card.id} card={card}
            running={Boolean(card.session?.running && !disconnected)} onOpen={() => onSelect({ id: card.id, project_id: projectId,
              revision: lanePage.sourceRevision, kind: "plan", document_type: card.kind, title: card.title,
              markdown: "", safe_path_label: card.id, updated_at: card.updatedAt })}
            onOpenSession={() => { if (card.session) onOpenSession(card.session.id); }} />)}
          <Typo.Caption>{copy.loaded(lanePage?.items.length ?? 0, page.laneCounts[lane.id])}</Typo.Caption>
          {lanePage?.nextCursor && <Button variant="borderless" disabled={board.loading} onClick={board.loadMore}>{copy.loadMore}</Button>}
        </Section></Box>;
        })}
      </div>
      {Object.values(page.laneCounts).every((count) => count === 0) && <Typo.Body>{copy.noWork}</Typo.Body>}
    </>}
  </Stack>;
}
