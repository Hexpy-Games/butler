import { useEpicDelete } from "./useEpicDelete.tsx";
import { canonStatusInput } from "./canonProgressSource.ts";
import { appCopy } from "@/app/copy.ts";
import { Tooltip, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Stack, ButtonContainer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, IconButton, MoreHorizontal } from "@/butler-ds";
import type { EpicCard, EpicInput, CanonPlan, CanonStatus } from "@/app/canonApi.ts";
export function PlanEpicActions({ epic, plans, busy, onWrite, onOpen }: {
  onOpen: () => void; epic: EpicCard; plans: CanonPlan[]; busy: boolean;
  onWrite: (epic: EpicCard, input: EpicInput, message: string) => void;
}) {
  const copy = appCopy.canon;
  const deletion = useEpicDelete(epic);
  const options = [{ id: null, title: copy.backlog }, ...plans];
  return <><ButtonContainer size="sm" wrap={false}>
    <Stack shrink={false}><Select value={epic.canon_status} disabled={busy}
      onValueChange={value => {
        const status = value as CanonStatus;
        onWrite(epic, canonStatusInput(epic, status), copy.statusChanged);
      }}>
      <SelectTrigger size="sm" aria-label={`${epic.title} · ${copy.status}`}><SelectValue /></SelectTrigger>
      <SelectContent>{Object.entries(copy.statuses).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
    </Select></Stack>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <IconButton label={appCopy.space.rowMenu(epic.title)} disabled={busy}><MoreHorizontal /></IconButton>
    </DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={onOpen}>{copy.openConversation}</DropdownMenuItem>
      <DropdownMenuSub><DropdownMenuSubTrigger>{copy.changePlan}</DropdownMenuSubTrigger><DropdownMenuSubContent>
        {options.map(plan => <DropdownMenuItem key={plan.id ?? "backlog"} disabled={epic.plan_id === plan.id}
          onSelect={() => onWrite(epic, { plan_id: plan.id }, copy.moved(plan.title))}>{plan.title}</DropdownMenuItem>)}
      </DropdownMenuSubContent></DropdownMenuSub>
      <Tooltip wrap label={epic.delete_blocked ? copy.deletion.running : undefined}><Stack><DropdownMenuItem variant="destructive" disabled={busy || epic.delete_blocked} onSelect={deletion.request}>{copy.deletion.action}</DropdownMenuItem></Stack></Tooltip>
    </DropdownMenuContent></DropdownMenu>
  </ButtonContainer>{deletion.dialog}</>;
}
