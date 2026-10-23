import { useState } from "react";
import { NavDropTarget, NavRow, Notebook, IconSlot, Stack, Typo } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { projectSpace } from "@/app/space/projection.ts";
import { useSessionUnread } from "@/app/space/unread.ts";
import { appCopy } from "@/app/copy.ts";
import type { EpicCard } from "@/app/canonApi.ts";
import { useLongPressAction } from "../layout/useLongPressAction.ts";
import { SpaceActivity } from "../space/SpaceActivity.tsx";
import { SpaceRowMenu } from "../space/SpaceRowMenu.tsx";
import { SpaceIdentity } from "../space/SpaceIdentity.tsx";
import { CanonAvatar } from "./CanonAvatar.tsx";
import { openEpicConversation } from "./canonNavigation.ts";
import { CANON_EPIC_MIME, useCanonSidebarDrag } from "./canonSidebarDrag.ts";

export function CanonEpicRow({ projectId, groupKey, epic, busy, onDrop }: {
  projectId: string; groupKey: string; epic: EpicCard; busy: boolean;
  onDrop: (sourceId: string, targetId: string, after: boolean) => void;
}) {
  const row = useButlerStore(state => epic.home_session_id ? projectSpace(state.navigation).get(`s:${epic.home_session_id}`) : undefined);
  const active = useButlerStore(state => state.activeChatId === epic.home_session_id && state.view.kind === "session");
  const unread = useSessionUnread(row?.session);
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPressAction(() => { if (row) setMenuOpen(true); });
  const [drop, setDrop] = useState<"before" | "after">();
  const source = useCanonSidebarDrag(state => state.source);
  const valid = source?.projectId === projectId && source.groupKey === groupKey && source.epic.id !== epic.id;
  return <NavDropTarget {...longPress} onPointerDown={event => { event.stopPropagation(); longPress.onPointerDown(event); }} data-canon-epic={epic.id} drop={valid ? drop : undefined}
    dragging={source?.epic.id === epic.id} draggable={!busy}
    onDragStart={event => {
      event.stopPropagation(); event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(CANON_EPIC_MIME, epic.id);
      useCanonSidebarDrag.getState().start(projectId, groupKey, epic);
    }} onDragEnd={() => { setDrop(undefined); useCanonSidebarDrag.getState().end(); }}
    onDragOver={event => {
      if (!source) return;
      event.stopPropagation();
      if (!valid || busy) { event.dataTransfer.dropEffect = "none"; return; }
      event.preventDefault(); event.dataTransfer.dropEffect = "move";
      const box = event.currentTarget.getBoundingClientRect();
      setDrop(event.clientY > box.top + box.height / 2 ? "after" : "before");
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(undefined); }}
    onDrop={event => {
      if (!source) return;
      event.preventDefault(); event.stopPropagation();
      if (valid && !busy) onDrop(source.epic.id, epic.id, drop === "after");
      setDrop(undefined); useCanonSidebarDrag.getState().end();
    }}>
    <NavRow dataTestClass="canon-epic-row" iconInteractive active={active} ariaLabel={epic.title}
      ariaDescription={unread ? appCopy.space.unread : undefined}
      icon={row ? <SpaceIdentity row={row} /> : <IconSlot size="sidebar"><Notebook /></IconSlot>}
      label={<Stack as="span" inline align="row" cross="center" gap="xs" minWidth="0">
        <Typo.Text as="span" truncate>{epic.title}</Typo.Text><CanonAvatar person={epic.assignee} />
      </Stack>}
      actions={row ? <SpaceRowMenu row={row} running={epic.run_state === "running"} open={menuOpen} onOpenChange={setMenuOpen} /> : <SpaceActivity running={epic.run_state === "running"} />}
      onContextMenu={row ? event => { event.preventDefault(); event.stopPropagation(); setMenuOpen(true); } : undefined}
      onClick={() => void openEpicConversation(projectId, epic)} />
  </NavDropTarget>;
}
