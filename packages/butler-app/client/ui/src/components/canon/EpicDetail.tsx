import { canonTaskCounts, canonStatusInput } from "./canonProgressSource.ts";
import { useButlerStore } from "@/app/store.ts";
import { useState, type Ref } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { EpicDetail as Epic, EpicInput, PlanCards, EpicProgressSnapshot, CanonStatus } from "@/app/canonApi.ts";
import { Box, Button, ButtonContainer, IconButton, KeyValueRow, NativeSelect, NativeSelectOption, Pencil, Stack, Typo } from "@/butler-ds";
import { CanonTagList } from "./CanonTagList.tsx";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { EpicEditForm } from "./EpicEditForm.tsx";
import { CanonPersonSelect } from "./CanonPersonSelect.tsx";
import { CanonPlanSelect } from "./CanonPlanSelect.tsx";
import { SpecTree } from "./SpecTree.tsx";
import { EpicProgress } from "./EpicProgress.tsx";
export function EpicDetail({ epic, plans, tasks, busy, onWrite, titleRef }: {
  titleRef?: Ref<HTMLElement>; epic: Epic; plans: PlanCards[]; tasks: EpicProgressSnapshot | null; busy: boolean;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>;
}) {
  useAppLocale();
  const [editing, setEditing] = useState(false);
  const copy = appCopy.canon;
  const plan = plans.find(plan => plan.id === epic.plan_id);
  const ordinal = plan ? plan.works.findIndex(work => work.id === epic.id) + 1 : 0;
  const statusChanged = (status: CanonStatus) => void onWrite(canonStatusInput(epic, status), copy.statusChanged);
  return <Stack gap="lg" data-test-class="canon-epic-detail" data-epic-id={epic.id}>
    {editing ? <EpicEditForm epic={epic} busy={busy} onSave={onWrite} onClose={() => setEditing(false)} /> : <Stack gap="sm">
      <Stack align="row" cross="start" justify="between" gap="sm">
        <Typo.PanelTitle as="h3" tabIndex={-1} ref={titleRef} wrap="anywhere">{epic.title}</Typo.PanelTitle>
        <ButtonContainer size="sm"><IconButton label={copy.edit} disabled={busy} onClick={() => setEditing(true)}><Pencil size="sm" /></IconButton></ButtonContainer>
      </Stack>
      <CanonTagList tags={epic.tags} />
      {epic.description && <Typo.Body wrap="pre">{epic.description}</Typo.Body>}
    </Stack>}
    <Stack gap="sm">
      <KeyValueRow valueTextSize="caption" label={copy.status} value={<NativeSelect size="sm" aria-label={copy.status} value={epic.canon_status} disabled={busy} onChange={event => statusChanged(event.target.value as CanonStatus)}>
        {Object.entries(copy.statuses).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
      </NativeSelect>} />
      <KeyValueRow valueTextSize="caption" label={copy.assignee} value={<Stack inline align="row" cross="center" gap="xs"><CanonAvatar person={epic.assignee} /><Box minWidth="0" shrink><CanonPersonSelect compact value={epic.assignee} disabled={busy} onChange={assignee => void onWrite({ assignee })} /></Box></Stack>} />
      <KeyValueRow valueTextSize="caption" label={copy.plan} value={<Stack inline align="row" cross="center" gap="xs">
        <Box minWidth="0" shrink>
        <CanonPlanSelect compact plans={plans} value={epic.plan_id} disabled={busy}
          onChange={plan_id => void onWrite({ plan_id }, copy.moved(plans.find(plan => plan.id === plan_id)?.title ?? copy.backlog))} /></Box>
        {ordinal > 0 && <Typo.Caption wrap="nowrap" shrink={false}>· {copy.ordinal(ordinal)}</Typo.Caption>}
      </Stack>} />
    </Stack>
    {epic.home_session_id && <ButtonContainer size="sm"><Button size="sm" variant="link"
      onClick={() => { if (epic.home_session_id) void useButlerStore.getState().openSession(epic.home_session_id); }}>{copy.openConversation}</Button></ButtonContainer>}
    <SpecTree nodes={epic.specs} />
    <EpicProgress tasks={tasks} counts={canonTaskCounts(epic)} />
  </Stack>;
}
