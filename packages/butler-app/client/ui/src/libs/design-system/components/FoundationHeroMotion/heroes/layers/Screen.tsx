import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { SceneGeometry } from "../scene/types";
import { Reveal as R } from "../shared/Reveal";
import { SHEETS, zToken, zValue, type LayersCopy, type Sheet } from "./layersCopy";
import { Overlay } from "./Overlay";
import { Scrim } from "./Scrim";
import { Sticky } from "./Sticky";
import { Page } from "./LayersPage";
import { clearance, quarter, TURN } from "./layersView";
import s from "./LayersHero.module.css";

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
 * sheets, hangs their labels), still in the poster.
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
          <div className={s.plane} data-plane data-t={t(`pl-${k}`)}>
            {content(sheet, copy, compact)}
          </div>
          {live ? <Pin copy={copy} k={k} sheet={sheet} /> : null}
        </div>
      ))}
    </div>
  );
}
