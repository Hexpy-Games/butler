import type { CSSProperties } from "react";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { Z, zValue, type LayersCopy } from "./layersCopy";
import s from "./LayersHero.module.css";

/** Layers of the composed screen, low to high. */
export const SCREEN = ["sticky", "drawer", "overlay", "dialog", "popover", "tooltip"] as const;

/** How far each layer steps from the one below when separated (canvas px, flat). */
export const SPREAD = { x: 20, y: 14 } as const;

/**
 * The token field: the stacking order as numbered sheets, each z token a
 * sheet laid over the one below, stepped along a flat diagonal.
 */
export function LayersField() {
  return (
    <div className={s.field}>
      <div className={s.sheets} data-m="field">
        {Z.map((name, k) => (
          <div className={s.sheet} data-t={`zs-${k}`} key={name} style={{ "--k": k } as CSSProperties}>
            <span className={s.sheetNum}><R name={`zs-${k}-v`}>{zValue(name) || "0"}</R></span>
            <span className={s.sheetName}><R name={`zs-${k}-n`}>{`--z-${name}`}</R></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Scenes 3 and 4: a screen built layer by layer (page, sticky header,
 * drawer, overlay, dialog, popover, tooltip), each layer with its z value;
 * then a "separate" slider spreads the layers apart along a flat diagonal
 * and closes them again.
 */
export function LayersScreen({ copy }: { copy: LayersCopy }) {
  return (
    <div className={s.screenRegion}>
      <div className={s.screenStage} data-m="screen">
        <div className={s.screen}>
          <div className={s.page} data-t="ly-page">
            <span className={s.pageLabel}><R name="ly-page-t">{copy.page}</R></span>
            {[0, 1, 2, 3, 4].map((line) => <span className={s.pageLine} key={line} />)}
          </div>
          {SCREEN.map((layer, k) => (
            <div className={s.plane} data-layer={layer} data-t={`ly-${k}`} key={layer}>
              <span className={s.planeNote}><R name={`ly-${k}-n`}>{`--z-${layer} ${zValue(layer)}`}</R></span>
            </div>
          ))}
        </div>
        <div className={s.slider}>
          <span className={s.sliderLabel}><R name="sep-t">{copy.separate}</R></span>
          <span className={s.track}><span className={s.thumb} data-t="sep-thumb" /></span>
          <Roller className={s.sliderRead} id="sep" poster={0} values={["0px", `${SPREAD.x}px`]} />
        </div>
      </div>
    </div>
  );
}
