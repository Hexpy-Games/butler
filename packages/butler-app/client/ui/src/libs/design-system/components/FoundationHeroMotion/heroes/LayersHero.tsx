import { type CSSProperties } from "react";
import v from "../heroVariants.module.css";

const PLANES = ["page", "drawer", "dialog", "popover"] as const;
/** The stacking token each plane sits on (the page is the base). */
const LAYER_TOKENS: Record<(typeof PLANES)[number], string> = { page: "page", drawer: "--z-drawer", dialog: "--z-dialog", popover: "--z-popover" };

/** 09 Layers: the composed screen tilts into an exploded view of its z-layers, then settles back. */
export function LayersHero() {
  return (
    <span className={v.scene}>
      <span className={v.planeStack}>
        {PLANES.map((plane, k) => (
          <span className={v.plane} data-plane={plane} key={plane} style={{ "--k": k } as CSSProperties}>
            {plane === "page" ? <span className={v.surfaceLines}><span /><span /><span /></span> : null}
            {plane === "dialog" ? <span className={v.dialogCard}><span className={v.surfaceLines}><span /><span /></span></span> : null}
            {plane === "popover" ? <span className={v.popoverCard}><span /><span /></span> : null}
            <span className={v.planeLabel}>{LAYER_TOKENS[plane]}</span>
          </span>
        ))}
      </span>
    </span>
  );
}
