import type { CSSProperties, DragEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import {
  canGroupSessions,
  moveTreeItem,
} from "@/app/prototypes/sidebar-space/tree-move";
import { Typo } from "@/butler-ds";
import { useTreeDrag } from "./hooks/useTreeDrag";
import styles from "./SidebarInteractions.module.css";

export function TreeDragItem({
  id,
  children,
  enabled = true,
}: {
  id: string;
  children: ReactNode;
  enabled?: boolean;
}) {
  const instance = useId();
  const [bounds, setBounds] = useState({ top: 0, height: 0 });
  const kind = useMock((s) => s.items.find((item) => item.id === id)?.kind);
  const placement = useTreeDrag((s) =>
    s.target?.instance === instance ? s.target.position : undefined,
  );
  const dragging = useTreeDrag((s) => s.sourceInstance === instance);
  function over(event: DragEvent<HTMLDivElement>) {
    if (!useTreeDrag.getState().dragged) return;
    if (!enabled) {
      event.stopPropagation();
      event.dataTransfer.dropEffect = "none";
      useTreeDrag.getState().over(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget.querySelector(
      '[data-test-class="tree-row"]',
    )!;
    const rect = row.getBoundingClientRect();
    const top = rect.top - event.currentTarget.getBoundingClientRect().top;
    setBounds((previous) =>
      previous.top === top && previous.height === rect.height
        ? previous
        : { top, height: rect.height },
    );
    const ratio = (event.clientY - rect.top) / rect.height;
    const position =
      ratio > 0.25 && ratio < 0.75
        ? kind === "session"
          ? "group"
          : "inside"
        : ratio < 0.5
          ? "before"
          : "after";
    const possible = (position === "group" ? canGroupSessions : moveTreeItem)(
      useMock.getState().items,
      useTreeDrag.getState().dragged!,
      id,
      position,
    );
    event.dataTransfer.dropEffect = possible ? "move" : "none";
    useTreeDrag.getState().over(possible ? { id, instance, position } : null);
  }
  return (
    <div
      data-tree-item={id}
      data-drag-instance={instance}
      data-session-id={kind === "session" ? id : undefined}
      className={styles.dragItem}
      data-drop={placement}
      style={
        {
          "--drop-row-top": `${bounds.top}px`,
          "--drop-row-height": `${bounds.height}px`,
        } as CSSProperties
      }
      data-dragging={dragging || undefined}
      draggable={enabled || kind === "session"}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.setData("application/x-butler-mock-tree", id);
        if (kind === "session")
          event.dataTransfer.setData("application/x-butler-mock-session", id);
        event.dataTransfer.effectAllowed = "copyMove";
        useTreeDrag.getState().start(id, instance);
      }}
      onDragOver={over}
      onDragLeave={(event) => {
        if (
          useTreeDrag.getState().target?.instance === instance &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        )
          useTreeDrag.getState().over(null);
      }}
      onDragEnd={() => useTreeDrag.getState().end()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const { dragged, target, end } = useTreeDrag.getState();
        if (enabled && dragged && target?.instance === instance)
          useMock.getState().drop(dragged, id, target.position);
        end();
      }}
    >
      {children}
      {placement === "group" && (
        <span className={styles.groupHint}>
          <Typo.Caption>그룹으로 묶기</Typo.Caption>
        </span>
      )}
    </div>
  );
}
