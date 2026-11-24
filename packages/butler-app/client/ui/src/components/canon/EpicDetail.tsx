import { EpicDetailActions } from "./EpicDetailActions.tsx";
import { EpicActivity } from "./EpicActivity.tsx";
import { EpicMcpProposals } from "./EpicMcpProposals.tsx";
import { useCanonPersonName } from "./useCanonPersonName.ts";
import { LOCAL_PERSON_ID } from "./localPerson.ts";
import { canonStatusInput } from "./canonProgressSource.ts";
import { useCanonOnlineLock } from "@/app/canonOnline.ts";
import { useButlerStore } from "@/app/store.ts";
import type { Ref } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { EpicDetail as Epic, EpicInput, PlanCards, EpicProgressSnapshot, CanonStatus } from "@/app/canonApi.ts";
import { Box, Button, ButtonContainer, KeyValueRow, NativeSelect, NativeSelectOption, Stack, Tooltip, Typo } from "@/butler-ds";
import { CanonTagsField } from "./CanonTagsField.tsx";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { CanonInlineDraftProvider } from "./CanonInlineDraft.tsx";
import { EpicInlineFields } from "./EpicInlineFields.tsx";
import { CanonPersonSelect } from "./CanonPersonSelect.tsx";
import { CanonPlanSelect } from "./CanonPlanSelect.tsx";
import { SpecTree } from "./SpecTree.tsx";
import { EpicSessionSummary } from "./EpicSessionSummary.tsx";
export function EpicDetail({ epic, plans, tasks, busy, onWrite, onRefresh, titleRef, compact = false, showConversation = true }: {
  showConversation?: boolean;
  compact?: boolean;
  titleRef?: Ref<HTMLElement>; epic: Epic; plans: PlanCards[]; tasks: EpicProgressSnapshot | null; busy: boolean;
  onRefresh: () => Promise<void>;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>;
}) {
  useAppLocale();
  const copy = appCopy.canon;
  const person = useCanonPersonName();
  const locked = useCanonOnlineLock(epic.project_id);
  const disabled = busy || Boolean(locked);
  const plan = plans.find(plan => plan.id === epic.plan_id);
  const ordinal = plan ? plan.works.findIndex(work => work.id === epic.id) + 1 : 0;
  const statusChanged = (status: CanonStatus) => void onWrite(canonStatusInput(epic, status), copy.statusChanged);
  const properties = <Stack gap="sm">
      <KeyValueRow valueTextSize="caption" label={copy.status} value={<Tooltip wrap label={locked ?? (tasks?.running ? `${copy.running} · ${copy.runningCancel}` : undefined)} side="top"><NativeSelect size="sm" aria-label={copy.status} value={epic.canon_status} disabled={disabled} onChange={event => statusChanged(event.target.value as CanonStatus)}>
        {Object.entries(copy.statuses).map(([value, label]) => <NativeSelectOption key={value} value={value} disabled={Boolean(tasks?.running && (value === "done" || value === "cancelled"))}>{label}</NativeSelectOption>)}
      </NativeSelect></Tooltip>} />
      <KeyValueRow valueTextSize="caption" label={copy.assignee} value={<Tooltip label={locked}><Stack gap="xs" cross="end" minWidth="0">
        <Stack inline align="row" cross="center" gap="xs" minWidth="0" maxWidth="full"><CanonAvatar agent={epic.agent} person={epic.assignee} /><Stack gap="none" minWidth="0" shrink><CanonPersonSelect compact value={epic.assignee} disabled={disabled} onChange={assignee => void onWrite({ assignee })} /></Stack></Stack>
        {epic.agent && <Typo.Caption tone="secondary" align="end" wrap="anywhere">{copy.mcp.working(epic.agent.person === LOCAL_PERSON_ID ? person : epic.agent.person, epic.agent.via)}</Typo.Caption>}
      </Stack></Tooltip>} />
      <KeyValueRow valueTextSize="caption" label={copy.plan} value={<Tooltip label={locked}><Stack inline align="row" cross="center" gap="xs">
        <Box minWidth="0" shrink>
        <CanonPlanSelect compact plans={plans} value={epic.plan_id} disabled={disabled}
          onChange={plan_id => void onWrite({ plan_id }, copy.moved(plans.find(plan => plan.id === plan_id)?.title ?? copy.backlog))} /></Box>
        {ordinal > 0 && <Typo.Caption wrap="nowrap" shrink={false}>· {copy.ordinal(ordinal)}</Typo.Caption>}
      </Stack></Tooltip>} />
      <KeyValueRow valueTextSize="caption" label={<Typo.Caption wrap="nowrap">{copy.tags.label}</Typo.Caption>} value={<Tooltip label={locked}><Box minWidth="0" shrink>
        <CanonTagsField row projectId={epic.project_id} value={epic.tags} disabled={disabled}
          onChange={tags => void onWrite({ tags: tags.map(tag => tag.id) })} />
      </Box></Tooltip>} />
    </Stack>;
  return <Stack gap="lg" data-test-class="canon-epic-detail" data-epic-id={epic.id}>
    <CanonInlineDraftProvider><EpicInlineFields epic={epic} busy={disabled} locked={locked} onWrite={onWrite} titleRef={titleRef} compact={compact}
      titleAction={<EpicDetailActions epic={epic} busy={busy} locked={locked} />}
      summary={<Stack align="row" cross="center" gap="xs"><CanonAvatar person={epic.assignee} agent={epic.agent} /><Typo.Caption tone="secondary">{copy.statuses[epic.canon_status]} · {plan?.title ?? copy.backlog}</Typo.Caption></Stack>} /></CanonInlineDraftProvider>
    {properties}
    <EpicSessionSummary epic={epic} tasks={tasks} />
    {showConversation && epic.home_session_id && <ButtonContainer size="sm"><Button size="sm" variant="outline"
      onClick={() => { if (epic.home_session_id) void useButlerStore.getState().openSession(epic.home_session_id); }}>{copy.openConversation}</Button></ButtonContainer>}
    <SpecTree nodes={epic.specs} criteria={epic.criteria} onRefresh={onRefresh} compact={compact} />
    <EpicMcpProposals epic={epic} onRefresh={onRefresh} />
    <EpicActivity epic={epic} plans={plans} />
  </Stack>;
}
