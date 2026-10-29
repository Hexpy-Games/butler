import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { projectSpace, type SpaceRowData } from "@/app/space/projection";
import { unreadAncestors } from "@/app/space/unread";
import { ButtonContainer, ChevronDown, ChevronRight, IconButton, LayoutDashboard, NavRowSwap, UnreadDot } from "@/butler-ds";
import { SpaceRowMenu } from "./SpaceRowMenu";

/**
 * Project navigation stays visible; the disclosure chevron gives way to the row
 * menu on hover. A folded group holding an unread chat rests on the unread dot.
 */
export function SpaceRowActions({ row, collapsible, menuOpen, onMenuChange, nested = false }: {
  row: SpaceRowData;
  collapsible: boolean;
  menuOpen: boolean;
  onMenuChange(open: boolean): void;
  /** The row shows its unfinished subtasks beneath it. */
  nested?: boolean;
}) {
  useAppLocale();
  const expanded = useOrganization(s => !s.collapsed.includes(row.node.key));
  const toggle = useOrganization(s => s.toggle);
  const unreadInside = useButlerStore(s => unreadAncestors(projectSpace(s.navigation)).has(row.node.key));
  const showDot = !expanded && unreadInside;
  // The dot keeps the rest slot until its exit fade ends; then the chevron returns.
  const [dotMounted, setDotMounted] = useState(showDot);
  if (showDot && !dotMounted) setDotMounted(true);
  const menu = <SpaceRowMenu row={row} nested={nested} open={menuOpen} onOpenChange={onMenuChange} />;
  if (row.node.kind === "session") return menu;
  return (
    <ButtonContainer size="icon-sm" wrap={false}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}>
      {row.node.kind === "project" && (
        <IconButton
          label={`${row.title} ${appCopy.space.dashboard}`}
          onClick={() => useButlerStore.getState().openProjectDashboard(row.node.entityId)}>
          <LayoutDashboard />
        </IconButton>
      )}
      {collapsible ? (
        <NavRowSwap open={menuOpen} rest={dotMounted ? (
          <UnreadDot label={appCopy.space.unread} present={showDot} onExitComplete={() => setDotMounted(false)} />
        ) : (
          <IconButton
            // The row already toggles with Enter/Space. Keep one keyboard target for that action.
            tabIndex={-1}
            label={`${row.title} ${expanded ? appCopy.space.collapse : appCopy.space.expand}`}
            onClick={() => toggle(row.node.key)}>
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </IconButton>
        )}>
          {menu}
        </NavRowSwap>
      ) : menu}
    </ButtonContainer>
  );
}
