import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { Box, Button, ButtonContainer, Grid, IconButton, Pencil, Plus, Section, Stack, Typo } from "@/butler-ds";
import { useCanonBoard } from "./useCanonBoard.ts";
import { CanonPlanLanes } from "./CanonPlanLanes.tsx";
import { EpicCard } from "./EpicCard.tsx";
import { EpicCreateDialog } from "./EpicCreateDialog.tsx";
import { PlanFormDialog } from "./PlanFormDialog.tsx";
import { EpicDetailPanel } from "./EpicDetailPanel.tsx";

export function CanonBoard({ projectId, onOpenSession }: { projectId: string; onOpenSession: (id: string) => void }) {
  const locale = useAppLocale();
  const board = useCanonBoard(projectId);
  const [create, setCreate] = useState<{ planId: string | null } | null>(null);
  const [planForm, setPlanForm] = useState<{ plan?: CanonPlan } | null>(null);
  const copy = appCopy.canon;
  const canon = board.canon;
  return <Stack gap="lg" data-test-class="canon-board">
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="outline" onClick={() => setCreate({ planId: null })}><Plus size="sm" />{copy.newEpic}</Button>
      <Button size="sm" onClick={() => setPlanForm({})}><Plus size="sm" />{copy.newPlan}</Button>
    </ButtonContainer>
    {Boolean(board.error) && <Stack align="row" cross="center"><Typo.Caption role="status">{appCopy.feedback.dashboardRetry}</Typo.Caption>
      <Button size="sm" variant="ghost" onClick={() => void board.refresh()}>{appCopy.feedback.retry}</Button></Stack>}
    {!canon && !board.error && <Typo.Caption role="status">{appCopy.feedback.dashboardLoading}</Typo.Caption>}
    {canon && <Grid columns={board.selected ? { base: "1", wide: "main-aside" } : "1"} cross="start" gap="lg">
      <Stack gap="xl">
        <Section title={copy.backlog} actions={<Typo.Caption>{copy.backlogCount(canon.backlog.length)}</Typo.Caption>} data-canon-backlog>
          <Box surface="base" border="hairline" radius="control" padding="md">
            <Stack gap="sm">
              <Grid columns="auto-fill" gap="sm">{canon.backlog.map(epic => <EpicCard key={epic.id} epic={epic} selected={board.selected === epic.id} onSelect={board.select} />)}</Grid>
              {!canon.backlog.length && !canon.plans.length && <Typo.Caption tone="secondary">{copy.backlogDescription}</Typo.Caption>}
              <Button variant="borderless" size="xs" onClick={() => setCreate({ planId: null })}><Plus size="xs" />{copy.newEpic}</Button>
            </Stack>
          </Box>
        </Section>
        {canon.plans.map(plan => <Section key={plan.id} title={<Stack align="row" cross="baseline" gap="sm" wrap>
          <Typo.PanelSectionTitle>{plan.title}</Typo.PanelSectionTitle>
          <Typo.Caption tone="secondary">{planCaption(plan, locale)}</Typo.Caption>
        </Stack>} actions={<IconButton label={copy.edit} onClick={() => setPlanForm({ plan })}><Pencil size="sm" /></IconButton>}>
          <CanonPlanLanes plan={plan} selected={board.selected} onSelect={board.select} onCreate={planId => setCreate({ planId })} />
        </Section>)}
      </Stack>
      <EpicDetailPanel epic={board.detail} plans={canon.plans} tasks={board.tasks} busy={board.busy} onWrite={board.write}
        onOpenSession={onOpenSession} onClose={() => board.select(null)} />
    </Grid>}
    {create && <EpicCreateDialog projectId={projectId} plans={canon?.plans ?? []} defaultPlanId={create.planId} onClose={() => setCreate(null)}
      onRefresh={board.refresh} onCreated={epic => { board.select(epic.id); }} />}
    {planForm && <PlanFormDialog projectId={projectId} plan={planForm.plan} onClose={() => setPlanForm(null)} onRefresh={board.refresh} />}
  </Stack>;
}
function planCaption(plan: { works: Array<{ canon_status: string }>; due_on: string | null }, locale: string): string {
  const progress = appCopy.canon.done(plan.works.filter(epic => epic.canon_status === "done").length, plan.works.length);
  if (!plan.due_on) return progress;
  const date = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${plan.due_on}T00:00:00Z`));
  return `${progress} · ${appCopy.canon.due(date)}`;
}
