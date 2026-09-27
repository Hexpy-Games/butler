import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useState } from "react";
import { NavRootDropZone } from "@/butler-ds";
import { useSpaceDrag, canDrop } from "@/app/space/drag";
import { requestSpaceMove } from "@/app/space/move";
import type { SpaceRowData } from "@/app/space/projection";

export function SpaceRootDrop({ rows }: { rows: Map<string, SpaceRowData> }) {
  useAppLocale();
  const source = useSpaceDrag((s) => s.source);
  const [active, setActive] = useState(false);
  if (!source || !canDrop(rows, source, null, "inside")) return null;
  return (
    <NavRootDropZone
      active={active}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setActive(true);
        useSpaceDrag.getState().over(null);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setActive(false);
        requestSpaceMove(rows, source, null, "inside");
        useSpaceDrag.getState().end();
      }}
    >
      {appCopy.space.moveToRoot}
    </NavRootDropZone>
  );
}
