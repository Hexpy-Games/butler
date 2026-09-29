import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { KeyValueRow } from "../../../../blocks/KeyValueRow";
import { Typo } from "../../../Typo";
import type { SceneGeometry } from "../scene/types";
import { Reveal as R } from "../shared/Reveal";
import { GLASS, LAYERS, SHEETS, zToken, zValue, type LayersCopy, type Sheet } from "./layersCopy";
import { Overlay, Scrim, Sticky } from "./LayersOverlays";
import { Page } from "./LayersPage";
import { clearance, quarter, TURN } from "./layersView";
import s from "./LayersHero.module.css";

/** The title's touch: three offset copies of the word, merging into one. */
export function TitleCopies({ title }: { title: string }) {
  return (
    <span className={s.titleStack}>
      <span className={s.titleCopy} data-k="2" data-t="tc-2">
        {title}
      </span>
      <span className={s.titleCopy} data-k="1" data-t="tc-1">
        {title}
      </span>
      <span>{title}</span>
    </span>
  );
}

/** The window's layout follows the hero's canvas: the phone canvas shows the compact app (no docked sidebar). */
function useCompact(ref: RefObject<HTMLElement | null>) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const board = ref.current?.parentElement?.closest<HTMLElement>("[data-layout]");
    if (!board) return undefined;
    const read = () => setCompact(board.dataset.layout === "tall");
    read();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(read) : null;
    observer?.observe(board, {
      attributeFilter: ["data-layout"],
      attributes: true,
    });
    return () => observer?.disconnect();
  }, [ref]);
  return compact;
}

function content(sheet: Sheet, copy: LayersCopy, compact: boolean): ReactNode {
  switch (sheet) {
    case "page":
      return <Page compact={compact} copy={copy} />;
    case "sticky":
      return <Sticky compact={compact} copy={copy} />;
    case "overlay":
      return <Scrim />;
    default:
      return <Overlay copy={copy} part={sheet} />;
  }
}

/** How many rings, one sheet-px apart, make a sheet's thickness. */
const SLAB_RINGS = Array.from({ length: 12 }, (_, i) => i + 1);

/** A sheet's thickness: its outline repeated down its own z, so the edge reads as a solid side, corners rounded like the sheet's. */
function Slab({ k }: { k: number }) {
  return (
    <span className={s.slab} data-t={`slab-${k}`}>
      {SLAB_RINGS.map((i) => (
        <span className={s.ring} key={i} style={{ "--i": i } as CSSProperties} />
      ))}
    </span>
  );
}

/** A sheet's label, hung on its top right corner and turned back to face the frame: token and value, then what lives there. */
function Pin({ copy, sheet, k }: { copy: LayersCopy; sheet: Sheet; k: number }) {
  return (
    <span className={s.pin} data-t={`pin-${k}`}>
      <span className={s.tag}>
        <span className={s.tagHead}>
          <span className={s.tagToken}>
            <R name={`lb-${k}-t`}>{zToken(sheet)}</R>
          </span>
          <span className={s.tagValue}>
            <R name={`lb-${k}-v`}>{zValue(sheet)}</R>
          </span>
        </span>
        <span className={s.tagLives}>
          <R name={`lb-${k}-d`}>{copy.lives[sheet]}</R>
        </span>
      </span>
    </span>
  );
}

/**
 * The Butler window as a stack of full-size sheets, one per open layer, low
 * to high: each draws only what lives on it, where it sits in the window, so
 * flat they are one screen. Live in the scene (the timeline lifts the
 * sheets, draws their rims and hangs their labels), still in the poster.
 */
export function Screen({ copy, live, g = null }: { copy: LayersCopy; live: boolean; g?: SceneGeometry | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const compact = useCompact(ref);
  const t = (name: string) => (live ? name : undefined);
  const view = g?.boxes.screen ? { ...TURN[g.layout], clear: clearance(g.layout), s: quarter(g.canvas, g.boxes.screen, g.layout, true).s } : null;
  const style = view
    ? ({
        "--q-rx": `${view.rx}deg`,
        "--q-rz": `${view.rz}deg`,
        "--q-s": view.s,
        "--q-clear": `${view.clear}px`,
      } as CSSProperties)
    : undefined;
  return (
    <div className={s.screen} data-m={live ? "screen" : undefined} ref={ref} style={style}>
      {SHEETS.map((sheet, k) => (
        <div className={s.sheet} data-sheet={sheet} data-t={t(`sh-${k}`)} key={sheet}>
          <div className={s.plane} data-t={t(`gp-${k}`)}>
            {content(sheet, copy, compact)}
          </div>
          {live && GLASS.includes(sheet) ? (
            <div className={`${s.plane} ${s.clear}`} data-t={`cp-${k}`}>
              {content(sheet, copy, compact)}
            </div>
          ) : null}
          {live && k > 0 ? <span className={s.rim} data-t={`rim-${k}`} /> : null}
          {live ? <Slab k={k} /> : null}
          {live ? <Pin copy={copy} k={k} sheet={sheet} /> : null}
        </div>
      ))}
    </div>
  );
}

/** The poster's window, drawn smaller to fit its tile. */
export function PosterScreen({ copy }: { copy: LayersCopy }) {
  return (
    <div className={s.posterScreen}>
      <Screen copy={copy} live={false} />
    </div>
  );
}

/** Finale: every z token, high to low, with its value and what lives there. */
export function Ladder({ copy }: { copy: LayersCopy }) {
  return (
    <div className={s.ladder}>
      {[...LAYERS].reverse().map((layer) => (
        <KeyValueRow description={copy.lives[layer]} key={layer} label={<Typo.Code>{zToken(layer)}</Typo.Code>} value={zValue(layer)} />
      ))}
    </div>
  );
}
