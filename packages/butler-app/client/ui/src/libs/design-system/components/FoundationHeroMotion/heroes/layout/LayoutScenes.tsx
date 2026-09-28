import type { CSSProperties } from "react";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { LEGEND, MODES, WIDTHS, tokenValue, type LayoutCopy } from "./layoutCopy";
import s from "./LayoutHero.module.css";

/** Canvas px per device px of the resizing frame. */
export const SCALE = 0.36;

/** How far the frame's right edge has come in from 1280 at each width (canvas px). */
export const inset = (px: number) => (WIDTHS[0].px - px) * SCALE;

const GLYPH = ["title", "guide", "gutter", "column", "hatch"] as const;
const COLUMNS = 6;

/**
 * The token field: the page frame as a blueprint (titlebar band, safe-area
 * hatches at the edges, the max-width guides, columns with their gutter)
 * over a legend naming each measure.
 */
export function LayoutField() {
  return (
    <div className={s.field}>
      <div className={s.fieldBody} data-m="field">
        <div className={s.page}>
          {(["t", "r", "b", "l"] as const).map((side) => <span className={s.hatch} data-side={side} data-t={`lf-h-${side}`} key={side} />)}
          <span className={s.titleBand} data-t="lf-title" />
          <div className={s.container}>
            <span className={s.guide} data-side="l" data-t="lf-gl" />
            <span className={s.guide} data-side="r" data-t="lf-gr" />
            <div className={s.columns}>{Array.from({ length: COLUMNS }, (_, k) => <span className={s.column} data-t={`lf-c${k}`} key={k} />)}</div>
          </div>
        </div>
        <div className={s.legend}>
          {LEGEND.map((row, k) => (
            <span className={s.legendRow} data-t={`lg-${k}`} key={row.token}>
              <span className={s.glyph} data-kind={GLYPH[k]} />
              <span className={s.legendName}><R name={`lg-${k}-n`}>{row.token}</R></span>
              {row.value ? <span className={s.legendValue}><R name={`lg-${k}-v`}>{tokenValue(row.token)}</R></span> : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One of the frame's states: the shell as it lays out at that width. */
function Layer({ k }: { k: number }) {
  const width = WIDTHS[k]!;
  const tiles = width.columns * 2;
  return (
    <div className={s.layer} data-t={`rs-l${k}`} style={{ "--w": `${width.px * SCALE}px`, "--cols": width.columns } as CSSProperties}>
      <span className={s.miniTitle}>{width.mode === "expanded" ? null : <span className={s.burger} />}</span>
      <div className={s.miniBody}>
        {width.mode === "expanded" ? <span className={s.miniSide}>{[0, 1, 2, 3].map((row) => <span className={s.miniRow} key={row} />)}</span> : null}
        <span className={s.miniTiles}>{Array.from({ length: tiles }, (_, n) => <span className={s.miniTile} key={n} />)}</span>
      </div>
      {k === WIDTHS.length - 1 ? (
        <>
          <span className={s.miniDim} data-t="rs-dim" />
          <span className={s.miniDrawer} data-t="rs-drawer">{[0, 1, 2].map((row) => <span className={s.miniRow} key={row} />)}</span>
          <span className={s.hatch} data-side="t" data-t="rs-ht" />
          <span className={s.hatch} data-side="b" data-t="rs-hb" />
        </>
      ) : null}
    </div>
  );
}

/**
 * Scene 3: a width handle drags the frame 1280 → 1023 → 640 → 375. The
 * frame's edge follows the handle (the shell clips behind it), then the
 * shell relays out for the width: the mode reads expanded, medium, compact
 * (responsive.ts constants, not tokens), the tiles rewrap and the sidebar
 * becomes a drawer.
 */
export function LayoutResize({ copy }: { copy: LayoutCopy }) {
  return (
    <div className={s.resizeRegion}>
      <div className={s.resizeStage} data-m="resize" style={{ "--frame-w": `${WIDTHS[0].px * SCALE}px` } as CSSProperties}>
        <div className={s.readout}>
          <span className={s.readWidth}><Roller id="rw" poster={0} values={WIDTHS.map((w) => String(w.px))} />px</span>
          <span className={s.modes}>{MODES.map((mode, k) => <span className={s.mode} data-t={`md-${k}`} key={mode}>{mode}</span>)}</span>
          <span className={s.source}><R name="rs-src">{copy.source}</R></span>
        </div>
        <div className={s.screen}>
          <div className={s.window} data-t="rs-win">
            <div className={s.windowIn} data-t="rs-win-in">{WIDTHS.map((_, k) => <Layer k={k} key={k} />)}</div>
          </div>
          <span className={s.edgeLine} data-edge="t" data-t="rs-top" />
          <span className={s.edgeLine} data-edge="b" data-t="rs-bot" />
          <span className={s.edgeLine} data-edge="l" />
          <span className={s.edgeLine} data-edge="r" data-t="rs-right" />
          <span className={s.handle} data-t="rs-handle" />
        </div>
      </div>
    </div>
  );
}
