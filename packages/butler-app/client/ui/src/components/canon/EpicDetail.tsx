import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { EpicDetail as Epic, EpicInput, PlanCards, WorkTasks, CanonStatus } from "@/app/canonApi.ts";
import { ButtonContainer, IconButton, KeyValueRow, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Pencil, Stack, Typo } from "@/butler-ds";
import { EpicEditForm } from "./EpicEditForm.tsx";
import { CanonPersonSelect } from "./CanonPersonSelect.tsx";
import { CanonPlanSelect } from "./CanonPlanSelect.tsx";
import { SpecTree } from "./SpecTree.tsx";
import { EpicProgress } from "./EpicProgress.tsx";
export function EpicDetail({ epic, plans, tasks, busy, onWrite }: {
  epic: Epic; plans: PlanCards[]; tasks: WorkTasks | null; busy: boolean;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>;
}) {
  useAppLocale();
  const [editing, setEditing] = useState(false);
  const copy = appCopy.canon;
  const plan = plans.find(plan => plan.id === epic.plan_id);
  const ordinal = plan ? plan.works.findIndex(work => work.id === epic.id) + 1 : 0;
  const statusChanged = (status: CanonStatus) => void onWrite({ status,
    ...(["done", "cancelled"].includes(status) ? { expected_task_graph_revision: epic.task_graph_revision } : {}) }, copy.statusChanged);
  return <Stack gap="xl" data-test-class="canon-epic-detail" data-epic-id={epic.id}>
    {editing ? <EpicEditForm epic={epic} busy={busy} onSave={onWrite} onClose={() => setEditing(false)} /> : <Stack gap="sm">
      <Stack align="row" cross="start" justify="between" gap="sm">
        <Typo.PanelTitle wrap="anywhere">{epic.title}</Typo.PanelTitle>
        <ButtonContainer size="sm"><IconButton label={copy.edit} disabled={busy} onClick={() => setEditing(true)}><Pencil size="sm" /></IconButton></ButtonContainer>
      </Stack>
      {epic.description && <Typo.Body wrap="pre">{epic.description}</Typo.Body>}
    </Stack>}
    <Stack gap="sm">
      <KeyValueRow valueTextSize="caption" label={copy.status} value={<Select value={epic.canon_status} disabled={busy} onValueChange={value => statusChanged(value as CanonStatus)}>
        <SelectTrigger aria-label={copy.status}><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(copy.statuses).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>} />
      <KeyValueRow valueTextSize="caption" label={copy.assignee} value={<CanonPersonSelect value={epic.assignee} disabled={busy} onChange={assignee => void onWrite({ assignee })} />} />
      <KeyValueRow valueTextSize="caption" label={copy.plan} value={<Stack align="row" gap="xs" cross="center" wrap>
        <CanonPlanSelect plans={plans} value={epic.plan_id} disabled={busy}
          onChange={plan_id => void onWrite({ plan_id }, copy.moved(plans.find(plan => plan.id === plan_id)?.title ?? copy.backlog))} />
        {ordinal > 0 && <Typo.Caption>· {copy.ordinal(ordinal)}</Typo.Caption>}
      </Stack>} />
    </Stack>
    <SpecTree nodes={epic.specs} />
    <EpicProgress tasks={tasks} counts={epic.task_counts} />
  </Stack>;
}
