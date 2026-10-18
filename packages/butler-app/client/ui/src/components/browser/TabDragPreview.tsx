import { useState } from "react";
import { DragPreview } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { useBrowserTabDrag } from "./browserTabDrag";

/** The lifted tab once a strip tab leaves the strip; reordering inside the strip stays with TabStrip. */
export function TabDragPreview() {
  const drag = useBrowserTabDrag();
  // Same face as the strip tab: its title or the new-tab label, its favicon or the globe when it fails to load.
  const [brokenSrc, setBrokenSrc] = useState<string>();
  if (!drag.tabId || !drag.outside || drag.x === undefined || drag.y === undefined) return null;
  const src = drag.favicon && drag.favicon !== brokenSrc ? drag.favicon : undefined;
  const icon = src ? <img src={src} alt="" width={16} height={16} draggable={false} onError={() => setBrokenSrc(src)} /> : undefined;
  return <DragPreview kind="tab" at={{ x: drag.x, y: drag.y }} title={drag.title?.trim() || appCopy.browser.newTab} icon={icon} invalid={!drag.target} />;
}
