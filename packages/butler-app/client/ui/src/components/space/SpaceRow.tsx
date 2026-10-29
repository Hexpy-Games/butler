import { SpaceRowBranch } from "./SpaceRowBranch.tsx";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SpaceRowLabel } from "./SpaceRowLabel";
import { SpaceRowMeta } from "./SpaceRowMeta";
import { memo, useEffect, useRef, useState } from "react";
import {
  NavRow,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { projectSpace } from "@/app/space/projection";
import { useLongPressAction } from "../layout/useLongPressAction";
import { SpaceIdentity } from "./SpaceIdentity";
import { SpaceRowActions } from "./SpaceRowActions";
import { SpaceDragRow } from "./SpaceDragRow";
import { routeActiveChatId } from "@/app/space/routeActive";
import { useSessionUnread } from "@/app/space/unread";

export const SpaceRow = memo(function SpaceRow({ rowKey, flat = false, shortcut = false, depth = 0 }: {
  rowKey: string;
  flat?: boolean;
  shortcut?: boolean;
  depth?: number;
}) {
  useAppLocale();
  const liveRow = useButlerStore(s => projectSpace(s.navigation).get(rowKey));
  // A removed row keeps its last content while it folds away (CollapsibleList).
  const lastRow = useRef(liveRow);
  if (liveRow) lastRow.current = liveRow;
  const row = liveRow ?? lastRow.current;
  const active = useButlerStore(s => routeActiveChatId(s) === row?.node.entityId);
  const sessionUnread = useSessionUnread(row?.session);
  const revealPath = useOrganization((s) => s.revealPath);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shortcut && revealPath[0] === rowKey)
      rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealPath, rowKey, shortcut]);
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPressAction(() => setMenuOpen(true));
  if (!row) return null;
  const actions = (
    <SpaceRowActions row={row} collapsible={row.node.kind !== "session" && !shortcut}
      menuOpen={menuOpen} onMenuChange={setMenuOpen} />
  );
  const label = <SpaceRowLabel row={row} flat={flat} />;
  return (
    <SpaceDragRow row={row} enabled={!flat && !shortcut}>
      <div
        ref={rowRef}
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
          <SpaceRowBranch row={row} depth={depth} label={label} actions={actions} />
        ) : (
          <NavRow
            dataTestClass="tree-row"
            iconInteractive
            multiline={flat}
            icon={<SpaceIdentity row={row} />}
            label={label}
            meta={flat ? <SpaceRowMeta row={row} /> : undefined}
            active={active}
            ariaLabel={row.title}
            ariaDescription={sessionUnread ? appCopy.space.unread : undefined}
            actionsVisibility="visible"
            actions={actions}
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
