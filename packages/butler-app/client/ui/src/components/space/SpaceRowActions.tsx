import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";
import { ButtonContainer, ChevronDown, ChevronRight, IconButton, LayoutDashboard } from "@/butler-ds";
import { SpaceRowMenu } from "./SpaceRowMenu";
import styles from "./SpaceInteractions.module.css";

/** Project navigation stays visible; menu and disclosure share the trailing slot. */
export function SpaceRowActions({ row, collapsible, menuOpen, onMenuChange }: {
  row: SpaceRowData;
  collapsible: boolean;
  menuOpen: boolean;
  onMenuChange(open: boolean): void;
}) {
  useAppLocale();
  const expanded = useOrganization(s => !s.collapsed.includes(row.node.key));
  const toggle = useOrganization(s => s.toggle);
  const menu = <SpaceRowMenu row={row} open={menuOpen} onOpenChange={onMenuChange} />;
  if (row.node.kind === "session") return menu;
  return (
    <ButtonContainer size="icon-sm" wrap={false} className={styles.groupActions}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}>
      {row.node.kind === "project" && (
        <IconButton className={styles.dashboardButton}
          label={`${row.title} ${appCopy.space.dashboard}`}
          onClick={() => useButlerStore.getState().openProjectDashboard(row.node.entityId)}>
          <LayoutDashboard />
        </IconButton>
      )}
      {collapsible ? (
        <span className={styles.disclosureSlot} data-menu-open={menuOpen || undefined}>
          <IconButton className={styles.collapseButton}
            // The row already toggles with Enter/Space. Keep one keyboard target for that action.
            tabIndex={-1}
            label={`${row.title} ${expanded ? appCopy.space.collapse : appCopy.space.expand}`}
            onClick={() => toggle(row.node.key)}>
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </IconButton>
          {menu}
        </span>
      ) : menu}
    </ButtonContainer>
  );
}
