import { CanonTagChooser } from "./CanonTagChooser.tsx";
import { useCanonTags } from "./useCanonTags.ts";
import { CanonBoardPlanSelect } from "./CanonBoardPlanSelect.tsx";
import { useCanonPlanSelection } from "./useCanonPlanSelection.ts";
import { useMemo, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { Box, Button, ButtonContainer, Grid, KanbanDragScope, KanbanLane, Plus, Stack, Typo } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { canComplete, canonCards } from "./canonLanes.ts";
import { useCanonBoard } from "./useCanonBoard.ts";
import { CanonPlanLanes } from "./CanonPlanLanes.tsx";
import { EpicCard } from "./EpicCard.tsx";
import { EpicCreateDialog } from "./EpicCreateDialog.tsx";
import { PlanFormDialog } from "./PlanFormDialog.tsx";
import { useCanonSelection } from "./useCanonSelection.ts";

export function CanonBoard({ projectId, bottomInset }: { projectId: string; bottomInset?: number; onOpenSession: (id: string) => void }) {
  const locale = useAppLocale();
  const disconnected = useButlerStore(state => state.liveConnectionLost);
  const board = useCanonBoard(projectId);
  const selectionDetail = useCanonSelection(projectId);
  const [create, setCreate] = useState<{ planId: string | null } | null>(null);
  const [planForm, setPlanForm] = useState<{ plan?: CanonPlan } | null>(null);
  const { tags } = useCanonTags(projectId);
  const [filterState, setFilterState] = useState<{ projectId: string; ids: string[] }>({ projectId, ids: [] });
  // A deleted tag drops out of the filter instead of leaving the board empty.
  const tagFilter = (filterState.projectId === projectId ? filterState.ids : []).filter(id => tags.some(tag => tag.id === id));
  const setTagFilter = (ids: string[]) => setFilterState({ projectId, ids });
  const matches = (epic: { tags: { id: string }[] }) => !tagFilter.length || epic.tags.some(tag => tagFilter.includes(tag.id));
  const copy = appCopy.canon;
  const canon = board.canon?.project_id === projectId ? board.canon : null;
  const selection = useCanonPlanSelection(projectId, canon);
  const selectedPlan = canon?.plans.find(plan => plan.id === selection.id);
  const cards = useMemo(() => new Map(canon ? canonCards(canon).map(card => [card.id, card]) : []), [canon]);
  return <Stack gap="lg" data-test-class="canon-board">
    {disconnected && <Typo.Caption role="status">{appCopy.projectSignpost.disconnected}</Typo.Caption>}
    <Stack align="row" cross="center" justify="between" gap="sm" wrap>
    <Stack align="row" cross="center" gap="sm" minWidth="0" shrink wrap><Box minWidth="0" shrink><CanonBoardPlanSelect plans={canon?.plans ?? []} value={selection.id} bottomInset={bottomInset} onChange={id => { selection.select(id); selectionDetail.select(null); }} /></Box>
      <Box minWidth="0" shrink><CanonTagChooser filter tags={tags} value={tagFilter} onChange={setTagFilter} /></Box></Stack>
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="outline" onClick={() => setCreate({ planId: selection.id })}><Plus size="sm" />{copy.newEpic}</Button>
      <Button size="sm" onClick={() => setPlanForm({})}><Plus size="sm" />{copy.newPlan}</Button>
    </ButtonContainer>
    </Stack>
    {Boolean(board.error) && <Stack align="row" cross="center"><Typo.Caption role="status">{appCopy.feedback.dashboardRetry}</Typo.Caption>
      <Button size="sm" variant="ghost" onClick={() => void board.refresh()}>{appCopy.feedback.retry}</Button></Stack>}
    {!canon && !board.error && <Typo.Caption role="status">{appCopy.feedback.dashboardLoading}</Typo.Caption>}
    {canon && <Grid columns="1" cross="start" gap="lg">
      <KanbanDragScope onMove={move => void board.move(move)} disabled={board.busy || board.moving}
        canDrop={(id, lane) => canComplete(cards.get(id), lane)} labels={copy.drag}>
      <Stack gap="xl">
        {!selectedPlan && <Box data-canon-backlog>
          <KanbanLane laneId="backlog" label={copy.backlog} height="content" layout="grid" title={<Stack align="row" cross="baseline" gap="sm" wrap>
            <Typo.PanelTitle>{copy.backlog}</Typo.PanelTitle><Typo.Caption tone="secondary">{copy.backlogCount(canon.backlog.length)}</Typo.Caption>
          </Stack>}>
              {canon.backlog.filter(matches).map(epic => <EpicCard key={epic.id} epic={epic} selected={selectionDetail.selected === epic.id} onSelect={selectionDetail.select} />)}
              {!canon.backlog.length && !canon.plans.length && <Typo.Caption tone="secondary">{copy.backlogDescription}</Typo.Caption>}
              <Button variant="borderless" size="xs" onClick={() => setCreate({ planId: null })}><Plus size="xs" />{copy.newEpic}</Button>
          </KanbanLane>
        </Box>}
        {(selectedPlan ? [selectedPlan] : []).map(plan => <CanonPlanLanes key={plan.id} plan={plan} caption={planCaption(plan, locale)}
          matches={matches} selected={selectionDetail.selected} onSelect={selectionDetail.select} onCreate={planId => setCreate({ planId })}
          onEdit={() => setPlanForm({ plan })} />)}
      </Stack>
      </KanbanDragScope>
    </Grid>}
    {create && <EpicCreateDialog projectId={projectId} plans={canon?.plans ?? []} defaultPlanId={create.planId} onClose={() => setCreate(null)}
      onRefresh={board.refresh} onCreated={epic => { selectionDetail.select(epic.id); }} />}
    {planForm && <PlanFormDialog projectId={projectId} plan={planForm.plan} onCreated={id => { selection.select(id); selectionDetail.select(null); }} onClose={() => setPlanForm(null)} onRefresh={board.refresh} />}
  </Stack>;
}
function planCaption(plan: { works: Array<{ canon_status: string }>; due_on: string | null }, locale: string): string {
  const progress = appCopy.canon.done(plan.works.filter(epic => epic.canon_status === "done").length, plan.works.length);
  if (!plan.due_on) return progress;
  const date = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${plan.due_on}T00:00:00Z`));
  return `${progress} · ${appCopy.canon.due(date)}`;
}
