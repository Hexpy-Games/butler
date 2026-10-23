import { useState, type ReactNode } from "react";
import { appCopy } from "@/app/copy.ts";
import { CollapsibleList, CollapsibleNavGroup } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { useOrganization } from "@/app/space/organization.ts";
import { projectSpace, spaceChildren, type SpaceRowData } from "@/app/space/projection.ts";
import { unreadAncestors } from "@/app/space/unread.ts";
import { useSpaceDrag } from "@/app/space/drag.ts";
import { CanonSidebarGroups } from "../canon/CanonSidebarGroups.tsx";
import { SidebarSessionLoadMore } from "../layout/SidebarSessionLoadMore.tsx";
import { SpaceRow } from "./SpaceRow.tsx";
import { SpaceGlyph } from "./SpaceGlyph.tsx";
/** Expanded project contents share the existing branch's paging and collapse ownership. */
export function SpaceRowBranch({ row, depth, label, actions }: { row: SpaceRowData; depth: number; label: ReactNode; actions: ReactNode }) {
  const rowKey = row.node.key;
  const children = useButlerStore(state => spaceChildren(projectSpace(state.navigation), rowKey));
  const activeChild = useButlerStore(state => {
    const current = projectSpace(state.navigation).get(`s:${state.activeChatId}`);
    return children.find(child => child.node.key === current?.node.key || current?.ancestors.includes(child.node.key))?.node.key;
  });
  const expanded = useOrganization(state => !state.collapsed.includes(rowKey));
  const unreadInside = useButlerStore(state => unreadAncestors(projectSpace(state.navigation)).has(rowKey));
  const revealPath = useOrganization(state => state.revealPath);
  const [visibleCount, setVisibleCount] = useState(5);
  const limit = Math.max(visibleCount, children.findIndex(row => row.node.key === activeChild) + 1,
    children.findIndex(row => revealPath.includes(row.node.key)) + 1);
  return <CollapsibleNavGroup dataTestClass="tree-row" indented stickyDepth={depth} expanded={expanded}
    onToggle={() => useOrganization.getState().toggle(rowKey)} icon={<SpaceGlyph row={row} />} label={label} actions={actions}
    ariaDescription={!expanded && unreadInside ? appCopy.space.unread : undefined}>
    {expanded && row.project && <CanonSidebarGroups projectId={row.project.id} depth={depth + 1} />}
    <CollapsibleList scope={rowKey}>{children.slice(0, limit).map(child => <SpaceRow key={child.node.key} rowKey={child.node.key} depth={depth + 1} />)}</CollapsibleList>
    {children.length > limit && <div onDragOver={event => {
      if (!useSpaceDrag.getState().source) return;
      event.preventDefault(); event.stopPropagation(); useSpaceDrag.getState().over(null);
      setVisibleCount(count => Math.min(count + 5, children.length));
    }}><SidebarSessionLoadMore remainingCount={children.length - limit} onClick={() => setVisibleCount(limit + 5)} /></div>}
  </CollapsibleNavGroup>;
}
