import { appCopy } from "@/app/copy.ts";
import type { EpicCard } from "@/app/canonApi.ts";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, IconButton, MoreHorizontal, Stack, Tooltip } from "@/butler-ds";
import { useEpicDelete } from "./useEpicDelete.tsx";
export function EpicDetailActions({ epic, busy, running }: { epic: EpicCard; busy: boolean; running: boolean }) {
  const deletion = useEpicDelete(epic);
  const copy = appCopy.canon.deletion;
  return <><DropdownMenu><DropdownMenuTrigger asChild>
    <IconButton label={appCopy.space.rowMenu(epic.title)} disabled={busy}><MoreHorizontal /></IconButton>
  </DropdownMenuTrigger><DropdownMenuContent align="end">
    <Tooltip wrap label={running ? copy.running : undefined}><Stack><DropdownMenuItem variant="destructive" disabled={busy || running} onSelect={deletion.request}>{copy.action}</DropdownMenuItem></Stack></Tooltip>
  </DropdownMenuContent></DropdownMenu>{deletion.dialog}</>;
}
