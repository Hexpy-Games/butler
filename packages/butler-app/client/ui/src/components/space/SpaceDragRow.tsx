import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
  type DragEvent,
} from "react";
import {
  useSpaceDrag,
  canDrop,
  SESSION_REFERENCE_MIME,
} from "@/app/space/drag";
import { useOrganization } from "@/app/space/organization";
import { requestSpaceMove } from "@/app/space/move";
import { projectSpace, type SpaceRowData } from "@/app/space/projection";
import { useButlerStore } from "@/app/store";
import { Typo } from "@/butler-ds";
import styles from "./SpaceInteractions.module.css";

export function SpaceDragRow({
  row,
  enabled,
  children,
}: {
  row: SpaceRowData;
  enabled: boolean;
  children: ReactNode;
}) {
  useAppLocale();
  const instance = useId();
  const placement = useSpaceDrag((s) =>
    s.target?.instance === instance ? s.target.position : undefined,
  );
  const dragging = useSpaceDrag((s) => s.sourceInstance === instance);
  const [bounds, setBounds] = useState({ top: 0, height: 0 });
  function over(e: DragEvent<HTMLDivElement>) {
    const rows = projectSpace(useButlerStore.getState().navigation);
    const drag = useSpaceDrag.getState();
    if (!drag.source) return;
    e.stopPropagation();
    if (!enabled) {
      e.dataTransfer.dropEffect = "none";
      drag.over(null);
      return;
    }
    e.preventDefault();
    const header = e.currentTarget.querySelector(
      '[data-test-class="tree-row"]',
    );
    if (!header) return;
    const rect = header.getBoundingClientRect();
    const top = rect.top - e.currentTarget.getBoundingClientRect().top;
    setBounds((old) =>
      old.top === top && old.height === rect.height
        ? old
        : { top, height: rect.height },
    );
    const ratio = (e.clientY - rect.top) / rect.height;
    const position =
      ratio > 0.25 && ratio < 0.75
        ? row.node.kind === "session"
          ? "group"
          : "inside"
        : ratio < 0.5
          ? "before"
          : "after";
    const possible = canDrop(rows, drag.source, row.node.key, position);
    e.dataTransfer.dropEffect = possible ? "move" : "none";
    drag.over(possible ? { key: row.node.key, instance, position } : null);
  }
  return (
    <div
      className={styles.dragItem}
      data-tree-item={row.node.key}
      data-drag-instance={instance}
      data-drop={placement}
      data-dragging={dragging || undefined}
      style={
        {
          "--drop-row-top": `${bounds.top}px`,
          "--drop-row-height": `${bounds.height}px`,
        } as CSSProperties
      }
      draggable={enabled || row.node.kind === "session"}
      onDragOver={over}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("application/x-butler-space-node", JSON.stringify({ version: 1, nodeKey: row.node.key }));
        if (row.session)
          e.dataTransfer.setData(
            SESSION_REFERENCE_MIME,
            JSON.stringify({
              version: 1,
              sessionId: row.session.id,
              titleSnapshot: row.title,
            }),
          );
        useSpaceDrag.getState().start(row.node.key, instance);
      }}
      onDragLeave={(e) => {
        const drag = useSpaceDrag.getState();
        if (
          drag.target?.instance === instance &&
          !e.currentTarget.contains(e.relatedTarget as Node | null)
        )
          drag.over(null);
      }}
      onDragEnd={() => useSpaceDrag.getState().end()}
      onDrop={(e) => {
        const rows = projectSpace(useButlerStore.getState().navigation);
        e.preventDefault();
        e.stopPropagation();
        const { source, target, end } = useSpaceDrag.getState();
        if (enabled && source && target?.instance === instance) {
          if (target.position === "group") {
            void useOrganization.getState().mutate({
                  action: "group",
                  sourceKey: source,
                  targetKey: row.node.key,
                });
          } else {
            requestSpaceMove(rows, source, row.node.key, target.position);
          }
        }
        end();
      }}
    >
      {children}
      {placement === "group" && (
        <span className={styles.groupHint}>
          <Typo.Caption>{appCopy.space.groupTogether}</Typo.Caption>
        </span>
      )}
    </div>
  );
}
