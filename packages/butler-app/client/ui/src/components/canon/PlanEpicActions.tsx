import { appCopy } from "@/app/copy.ts";
import { NativeSelect, NativeSelectOption, ButtonContainer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, IconButton, MoreHorizontal } from "@/butler-ds";
import type { EpicCard, EpicInput, CanonPlan, CanonStatus } from "@/app/canonApi.ts";
export function PlanEpicActions({ epic, plans, busy, onWrite, onOpen }: {
  onOpen: () => void; epic: EpicCard; plans: CanonPlan[]; busy: boolean;
  onWrite: (epic: EpicCard, input: EpicInput, message: string) => void;
}) {
  const copy = appCopy.canon;
  const options = [{ id: null, title: copy.backlog }, ...plans];
  return <ButtonContainer size="sm" wrap>
    <NativeSelect size="sm" aria-label={`${epic.title} · ${copy.status}`} value={epic.canon_status} disabled={busy}
      onChange={event => {
        const status = event.target.value as CanonStatus;
        onWrite(epic, { status, ...(["done", "cancelled"].includes(status) ? { expected_task_graph_revision: epic.task_graph_revision } : {}) }, copy.statusChanged);
      }}>
      {Object.entries(copy.statuses).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
    </NativeSelect>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <IconButton label={appCopy.space.rowMenu(epic.title)} disabled={busy}><MoreHorizontal /></IconButton>
    </DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={onOpen}>{copy.openConversation}</DropdownMenuItem>
      <DropdownMenuSub><DropdownMenuSubTrigger>{copy.changePlan}</DropdownMenuSubTrigger><DropdownMenuSubContent>
        {options.map(plan => <DropdownMenuItem key={plan.id ?? "backlog"} disabled={epic.plan_id === plan.id}
          onSelect={() => onWrite(epic, { plan_id: plan.id }, copy.moved(plan.title))}>{plan.title}</DropdownMenuItem>)}
      </DropdownMenuSubContent></DropdownMenuSub>
    </DropdownMenuContent></DropdownMenu>
  </ButtonContainer>;
}
