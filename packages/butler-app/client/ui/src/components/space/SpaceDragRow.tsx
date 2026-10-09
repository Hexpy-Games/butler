import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useId, type ReactNode } from "react";
import { useSpaceDrag, SESSION_REFERENCE_MIME } from "@/app/space/drag";
import type { SpaceRowData } from "@/app/space/projection";
import { useBrowserTabDrag } from "../browser/browserTabDrag";
import { NavDropTarget } from "@/butler-ds";

/**
 * A draggable tree row. Drop zones and drops are resolved once for the whole
 * tree (SpaceDropScope); the row shows the feedback the store assigns it.
 */
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
  const target = useSpaceDrag((s) => (s.target?.instance === instance ? s.target : null));
  const tabTarget = useBrowserTabDrag((s) => s.target?.instance === instance ? s.target : undefined);
  const tabDragging = useBrowserTabDrag((s) => Boolean(s.tabId));
  const dragging = useSpaceDrag((s) => s.sourceInstance === instance);
  return (
    <NavDropTarget
      data-tree-item={row.node.key}
      data-drag-instance={instance}
      drop={tabTarget ? "outside" : enabled ? target?.position : undefined}
      dragging={dragging}
      indicator={target?.indicator}
      hint={tabTarget ? appCopy.browser.dropMoveTabTo(tabTarget.title) : appCopy.space.groupTogether}
      draggable={!tabDragging && (enabled || row.node.kind === "session")}
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
      onDragEnd={() => useSpaceDrag.getState().end()}
    >
      {children}
    </NavDropTarget>
  );
}
