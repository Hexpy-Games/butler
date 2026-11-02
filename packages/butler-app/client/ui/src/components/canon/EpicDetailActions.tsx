import { appCopy } from "@/app/copy.ts";
import type { EpicCard } from "@/app/canonApi.ts";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, IconButton, MoreHorizontal, Tooltip } from "@/butler-ds";
import { useEpicDelete } from "./useEpicDelete.tsx";
export function EpicDetailActions({ epic, busy }: { epic: EpicCard; busy: boolean }) {
  const deletion = useEpicDelete(epic);
  const copy = appCopy.canon.deletion;
  return <><DropdownMenu><DropdownMenuTrigger asChild>
    <IconButton label={appCopy.space.rowMenu(epic.title)} disabled={busy}><MoreHorizontal /></IconButton>
  </DropdownMenuTrigger><DropdownMenuContent align="end">
    <Tooltip wrap label={epic.delete_blocked ? copy.running : undefined}><DropdownMenuItem variant="destructive" disabled={busy || epic.delete_blocked} onSelect={deletion.request}>{copy.action}</DropdownMenuItem></Tooltip>
  </DropdownMenuContent></DropdownMenu>{deletion.dialog}</>;
}
