import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { ACTIVE_TURN_STATES } from "@/app/constants";
import { useButlerStore } from "@/app/store";
import { useComposerStore } from "../conversation/composerStore";
import type { SpaceRowData } from "@/app/space/projection";
import {
  Archive, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  IconButton, IconSlot, MessageSquarePlus, MoreHorizontal, Tooltip,
} from "@/butler-ds";
import { ClearGeneralDialog } from "./ClearGeneralDialog";

export function GeneralChannelMenu({ row, open, onOpenChange }: {
  row: SpaceRowData; open: boolean; onOpenChange(open: boolean): void;
}) {
  useAppLocale();
  const [confirm, setConfirm] = useState(false);
  const [ready, setReady] = useState(false);
  const view = useButlerStore(s => s.sessionViews.general);
  const busy = !ready || ACTIVE_TURN_STATES.has(view?.active_turn?.state ?? "") || ACTIVE_TURN_STATES.has(row.session?.active_turn_state ?? "") ||
    Boolean(view?.authority_requests?.length || row.session?.attention_required || row.session?.running_delegated_work);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReady(false);
    void useButlerStore.getState().refreshSessionObserver("general").then(loaded => { if (!cancelled) setReady(loaded); });
    return () => { cancelled = true; };
  }, [open]);
  return <>
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton label={appCopy.space.rowMenu(row.title)} selected={open}><MoreHorizontal size="sm" /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8}>
        <DropdownMenuItem onSelect={() => useComposerStore.getState().insertSessionReference?.({ sessionId: "general", titleSnapshot: row.title })}>
          <IconSlot size="sm"><MessageSquarePlus /></IconSlot>{appCopy.space.reference}
        </DropdownMenuItem>
        <Tooltip label={busy ? appCopy.clearChat.busy : undefined}>
          <DropdownMenuItem disabled={busy} onSelect={() => setConfirm(true)}>
            <IconSlot size="sm"><Archive /></IconSlot>{appCopy.clearChat.title}
          </DropdownMenuItem>
        </Tooltip>
      </DropdownMenuContent>
    </DropdownMenu>
    <ClearGeneralDialog open={confirm} onOpenChange={setConfirm} busy={busy} />
  </>;
}
