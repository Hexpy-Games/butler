import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { CanonSidebarGroup as Group, EpicCard } from "@/app/canonApi.ts";
import { useOrganization } from "@/app/space/organization.ts";
import { ButtonContainer, ChevronDown, ChevronRight, CollapsibleNavGroup, Folder, IconButton, ListChecks, NavDropTarget, NavRowSwap, OverflowActionMenu, Plus } from "@/butler-ds";
import { useLongPressAction } from "../layout/useLongPressAction.ts";
import { CanonEpicRow } from "./CanonEpicRow.tsx";
import { openPlanOverview } from "./canonNavigation.ts";
import { useCanonSidebarDrag } from "./canonSidebarDrag.ts";

export function CanonSidebarGroup({ projectId, group, depth, busy, onCreate, onEdit, onReorder, onMove }: {
  projectId: string; group: Group; depth: number; busy: boolean;
  onCreate: () => void; onEdit: () => void; onReorder: (ids: string[]) => void;
  onMove: (epic: EpicCard) => void;
}) {
  const key = `canon:${projectId}:${group.key}`;
  const expanded = useOrganization(state => !state.collapsed.includes(key));
  const toggle = () => useOrganization.getState().toggle(key);
  const [menuOpen, setMenuOpen] = useState(false), [over, setOver] = useState(false);
  const longPress = useLongPressAction(() => setMenuOpen(true));
  const source = useCanonSidebarDrag(state => state.source);
  const valid = source?.projectId === projectId && source.groupKey !== group.key;
  const title = group.kind === "backlog" ? appCopy.canon.backlog : group.title;
  const overview = () => openPlanOverview(projectId, group.kind === "backlog" ? null : group.key);
  const actions = <ButtonContainer size="icon-sm" wrap={false} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <IconButton label={appCopy.canon.newEpic} aria-label={appCopy.canon.newInGroup(title)} disabled={busy} onClick={onCreate}><Plus /></IconButton>
    <NavRowSwap open={menuOpen} rest={<IconButton tabIndex={-1} label={`${title} ${expanded ? appCopy.space.collapse : appCopy.space.expand}`} onClick={toggle}>
      {expanded ? <ChevronDown /> : <ChevronRight />}</IconButton>}>
      <OverflowActionMenu label={appCopy.space.rowMenu(title)} open={menuOpen} onOpenChange={setMenuOpen}
        items={[...(group.kind === "plan" ? [{ label: appCopy.canon.edit, onSelect: onEdit }] : []), { label: appCopy.canon.overview, onSelect: overview }]} />
    </NavRowSwap>
  </ButtonContainer>;
  const reorder = (source: string, target: string, after: boolean) => {
    const ids = group.rows.map(row => row.id).filter(id => id !== source);
    ids.splice(ids.indexOf(target) + Number(after), 0, source); onReorder(ids);
  };
  return <>
    <NavDropTarget {...longPress} onPointerDown={event => {
      event.stopPropagation();
      if ((event.target as Element).closest('[data-test-class="canon-sidebar-group"]')) longPress.onPointerDown(event);
    }} onContextMenu={event => {
      if (!(event.target as Element).closest('[data-test-class="canon-sidebar-group"]')) return;
      event.preventDefault(); event.stopPropagation(); setMenuOpen(true);
    }} data-canon-group={group.key} drop={valid && over ? "inside" : undefined}
      onDragOver={event => {
        if (!source) return;
        event.stopPropagation();
        if (!valid || busy || (event.target as Element).closest('[data-canon-epic]')) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(true);
      }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false); }}
      onDrop={event => {
        if (!source) return;
        event.preventDefault(); event.stopPropagation();
        if (valid && !busy) onMove(source.epic);
        setOver(false); useCanonSidebarDrag.getState().end();
      }}>
      <CollapsibleNavGroup indented stickyDepth={depth} dataTestClass="canon-sidebar-group" expanded={expanded} onToggle={toggle}
        icon={group.kind === "backlog" ? <Folder /> : <ListChecks />} actions={actions}
        label={title}>
        {group.rows.map(epic => <CanonEpicRow key={epic.id} projectId={projectId} groupKey={group.key} epic={epic} busy={busy} onDrop={reorder} />)}
      </CollapsibleNavGroup>
    </NavDropTarget>
  </>;
}
