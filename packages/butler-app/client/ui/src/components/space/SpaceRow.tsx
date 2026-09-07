import { SpaceRowLabel } from "./SpaceRowLabel";
import { memo, useEffect, useRef, useState } from "react";
import {
  ButtonContainer,
  ChevronDown,
  ChevronRight,
  CollapsibleNavGroup,
  IconButton,
  NavRow,
  Sparkles,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { projectSpace, spaceChildren } from "@/app/space/projection";
import { useLongPressAction } from "../layout/useLongPressAction";
import { SpaceGlyph, SpaceIdentity } from "./SpaceIdentity";
import { SpaceRowMenu } from "./SpaceRowMenu";
import { SidebarSessionLoadMore } from "../layout/SidebarSessionLoadMore";
import { SpaceDragRow } from "./SpaceDragRow";
import styles from "./SpaceSidebar.module.css";
import interaction from "./SpaceInteractions.module.css";

export const SpaceRow = memo(function SpaceRow({
  rowKey,
  flat = false,
  shortcut = false,
  depth = 0,
}: {
  rowKey: string;
  flat?: boolean;
  shortcut?: boolean;
  depth?: number;
}) {
  const row = useButlerStore(s => projectSpace(s.navigation).get(rowKey));
  const active = useButlerStore(s => s.activeChatId === row?.node.entityId);
  const children = useButlerStore(s => spaceChildren(projectSpace(s.navigation), rowKey));
  const activeChild = useButlerStore(s => {
    const current = projectSpace(s.navigation).get(`s:${s.activeChatId}`);
    return children.find(child => child.node.key === current?.node.key || current?.ancestors.includes(child.node.key))?.node.key;
  });
  const expanded = useOrganization((s) => !s.collapsed.includes(rowKey));
  const toggle = useOrganization((s) => s.toggle);
  const revealPath = useOrganization((s) => s.revealPath);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shortcut && revealPath[0] === rowKey)
      rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealPath, rowKey, shortcut]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(5);
  const longPress = useLongPressAction(() => setMenuOpen(true));
  if (!row) return null;
  const limit = Math.max(
    visibleCount,
    children.findIndex((r) => r.node.key === activeChild) + 1,
    children.findIndex((r) => revealPath.includes(r.node.key)) + 1,
  );
  const menu = (
    <SpaceRowMenu row={row} open={menuOpen} onOpenChange={setMenuOpen} />
  );
  const label = <SpaceRowLabel row={row} flat={flat} />;
  return (
    <SpaceDragRow row={row} enabled={!flat && !shortcut}>
      <div
        ref={rowRef}
        className={interaction.rowShell}
        {...longPress}
        onPointerDown={(e) => {
          e.stopPropagation();
          longPress.onPointerDown(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(true);
        }}
      >
        {row.node.kind !== "session" && !shortcut ? (
          <CollapsibleNavGroup
            dataTestClass="tree-row"
            indented
            stickyDepth={depth}
            expanded={expanded}
            onToggle={() => toggle(row.node.key)}
            icon={<SpaceGlyph row={row} />}
            label={
              <span className={styles.groupLabel}>
                {label}
                {row.smart && <Sparkles />}
              </span>
            }
            actions={
              <ButtonContainer
                size="icon-sm"
                wrap={false}
                className={interaction.groupActions}
                onClick={(e) => e.stopPropagation()}
              >
                {menu}
                <IconButton
                  className={interaction.collapseButton}
                  label={`${row.title} ${expanded ? "접기" : "펼치기"}`}
                  onClick={() => toggle(row.node.key)}
                >
                  {expanded ? <ChevronDown /> : <ChevronRight />}
                </IconButton>
              </ButtonContainer>
            }
          >
            {children.slice(0, limit).map((child) => (
              <SpaceRow
                key={child.node.key}
                rowKey={child.node.key}
                depth={depth + 1}
              />
            ))}
            {children.length > limit && (
              <SidebarSessionLoadMore
                remainingCount={children.length - limit}
                onClick={() => setVisibleCount(limit + 5)}
              />
            )}
          </CollapsibleNavGroup>
        ) : (
          <NavRow
            dataTestClass="tree-row"
            iconInteractive
            multiline={flat}
            icon={<SpaceIdentity row={row} />}
            label={label}
            active={active}
            ariaLabel={row.title}
            actionsVisibility="visible"
            actions={menu}
            onClick={() => {
              if (row.node.kind === "project")
                useButlerStore
                  .getState()
                  .openProjectDashboard(row.node.entityId);
              else useButlerStore.getState().openSession(row.node.entityId);
            }}
          />
        )}
      </div>
    </SpaceDragRow>
  );
});
