import { useState } from "react";
import {
  Button,
  ButtonContainer,
  ChevronDown,
  ChevronRight,
  CollapsibleNavGroup,
  IconButton,
  NavRow,
  Sparkles,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { useLongPressAction } from "@/components/layout/useLongPressAction";
import styles from "./SpaceMockup.module.css";
import interaction from "./SidebarInteractions.module.css";
import { ConversationIcon } from "./ConversationIcon";
import { SpaceRowLabel } from "./SpaceRowLabel";
import { FavoriteIcon } from "./FavoriteIcon";
import { TreeDragItem } from "./TreeDragItem";
import { SpaceItemMenu } from "./SpaceItemMenu";

export function SpaceRow({
  id,
  flat = false,
  shortcut = false,
  onOpen,
}: {
  id: string;
  flat?: boolean;
  shortcut?: boolean;
  onOpen?: () => void;
}) {
  const item = useMock((s) => s.items.find((row) => row.id === id)!);
  const items = useMock((s) => s.items);
  const activeId = useMock((s) => s.active);
  const expanded = useMock((s) => s.expanded.includes(id));
  const open = useMock((s) => s.open);
  const toggleGroup = useMock((s) => s.toggleGroup);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(5);
  const longPress = useLongPressAction(() => setMenuOpen(true));
  const menu = (
    <SpaceItemMenu id={id} open={menuOpen} onOpenChange={setMenuOpen} />
  );
  const children = items.filter((row) => row.parent === id);
  const limit = Math.max(
    visibleCount,
    children.findIndex((row) => row.id === activeId) + 1,
  );
  let depth = 0;
  let parent = items.find((row) => row.id === item.parent);
  while (parent) {
    depth += 1;
    parent = items.find((row) => row.id === parent?.parent);
  }
  return (
    <TreeDragItem id={id} enabled={!flat && !shortcut}>
      <div
        className={interaction.rowShell}
        data-menu-open={menuOpen || undefined}
        {...longPress}
        onPointerDown={(event) => {
          event.stopPropagation();
          longPress.onPointerDown(event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(true);
        }}
      >
        {item.kind !== "session" && !shortcut ? (
          <CollapsibleNavGroup
            dataTestClass="tree-row"
            indented
            stickyDepth={depth}
            expanded={expanded}
            onToggle={() => toggleGroup(id)}
            icon={<ConversationIcon id={id} />}
            label={
              <span className={styles.groupLabel} title={item.title}>
                <span className={interaction.singleTitle}>{item.title}</span>
                {item.smart && <Sparkles size={14} />}
              </span>
            }
            actions={
              <ButtonContainer
                size="icon-sm"
                wrap={false}
                className={interaction.groupActions}
                onClick={(event) => event.stopPropagation()}
              >
                {menu}
                <IconButton
                  className={interaction.collapseButton}
                  label={`${item.title} ${expanded ? "접기" : "펼치기"}`}
                  onClick={() => toggleGroup(id)}
                >
                  {expanded ? <ChevronDown /> : <ChevronRight />}
                </IconButton>
              </ButtonContainer>
            }
          >
            {children.slice(0, limit).map((row) => (
              <SpaceRow key={row.id} id={row.id} />
            ))}
            {children.length > limit && (
              <ButtonContainer size="sm">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setVisibleCount(limit + 5)}
                >
                  나머지 {children.length - limit}개 더보기
                </Button>
              </ButtonContainer>
            )}
          </CollapsibleNavGroup>
        ) : (
          <NavRow
            dataTestClass="tree-row"
            iconInteractive
            multiline={flat}
            icon={<FavoriteIcon id={id} />}
            label={<SpaceRowLabel id={id} flat={flat} />}
            active={activeId === id}
            onClick={() => {
              open(id);
              onOpen?.();
            }}
            ariaLabel={item.title}
            actionsVisibility="visible"
            actions={menu}
          />
        )}
      </div>
    </TreeDragItem>
  );
}
