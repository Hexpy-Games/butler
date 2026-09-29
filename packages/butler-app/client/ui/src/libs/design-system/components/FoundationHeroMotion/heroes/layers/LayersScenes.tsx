import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { KeyValueRow } from "../../../../blocks/KeyValueRow";
import { Typo } from "../../../Typo";
import type { SceneGeometry } from "../scene/types";
import { Reveal as R } from "../shared/Reveal";
import { LAYERS, SHEETS, zToken, zValue, type LayersCopy, type Sheet } from "./layersCopy";
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

/** A component's silhouette on its sheet, in sheet px (x, y, w, h and the corner radius). */
interface Ext {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** Length of a computed `translate` part ("-50%" of the element's own size, or px). */
function length(part: string | undefined, size: number): number {
  if (!part) return 0;
  return part.endsWith("%") ? (Number.parseFloat(part) / 100) * size : Number.parseFloat(part) || 0;
}

/** Where a component sits on its plane, from layout alone (offsets ignore transforms, so the camera can be anywhere), adding back its own translate. */
function boxIn(el: HTMLElement, plane: HTMLElement): Ext {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== plane) {
    const cs = getComputedStyle(cur);
    const [tx, ty] = cs.translate && cs.translate !== "none" ? cs.translate.split(" ") : [];
    const m = cs.transform && cs.transform !== "none" ? new DOMMatrix(cs.transform) : null;
    x += cur.offsetLeft + length(tx, cur.offsetWidth) + (m?.e ?? 0);
    y += cur.offsetTop + length(ty, cur.offsetHeight) + (m?.f ?? 0);
    const parent = cur.offsetParent as HTMLElement | null;
    if (parent && parent !== plane) {
      x += parent.clientLeft;
      y += parent.clientTop;
    }
    cur = parent;
  }
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const r = Math.min(Number.parseFloat(getComputedStyle(el).borderBottomRightRadius) || 0, w / 2, h / 2);
  return { x, y, w, h, r };
}

/** The components of every sheet (marked `data-ext`; the page's is the window itself), measured on the layout so the extrusions follow their real shapes. */
function useExtrusions(ref: RefObject<HTMLElement | null>, live: boolean) {
  const [boxes, setBoxes] = useState<Ext[][]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!live || !root) return undefined;
    const measure = () => {
      const next = [...root.querySelectorAll<HTMLElement>(":scope > [data-sheet]")].map((sheet, k) => {
        const plane = sheet.querySelector<HTMLElement>("[data-plane]");
        if (k === 0) return [{ x: 0, y: 0, w: root.offsetWidth, h: root.offsetHeight, r: Number.parseFloat(getComputedStyle(root).getPropertyValue("--app-window-radius")) || 0 }];
        return plane ? [...plane.querySelectorAll<HTMLElement>("[data-ext]")].map((el) => boxIn(el, plane)) : [];
      });
      setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    void document.fonts?.ready.then(measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [ref, live]);
  return boxes;
}

/** A component's thickness: the side faces the quarter view sees (bottom edge, right edge, the corner between), following its shape and sharing one fade. */
function Slab({ k, box }: { k: number; box: Ext }) {
  const style = { "--x": `${box.x}px`, "--y": `${box.y}px`, "--w": `${box.w}px`, "--h": `${box.h}px`, "--r": `${box.r}px` } as CSSProperties;
  return (
    <>
      <span className={`${s.face} ${s.faceBottom}`} data-t={`slab-${k}`} style={style} />
      <span className={`${s.face} ${s.faceRight}`} data-t={`slab-${k}`} style={style} />
      {box.r > 1 ? <span className={`${s.face} ${s.faceCorner}`} data-t={`slab-${k}`} style={style} /> : null}
    </>
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
  const boxes = useExtrusions(ref, live);
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
          {live && sheet === "overlay" ? <span className={s.rim} data-t={`rim-${k}`} /> : null}
          {live ? (boxes[k] ?? []).map((box, i) => <Slab box={box} k={k} key={i} />) : null}
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

/** Finale: every z token, high to low, with its value and what lives there (live in the scene: each row is written in turn). */
export function Ladder({ copy, live = false }: { copy: LayersCopy; live?: boolean }) {
  return (
    <div className={s.ladder}>
      {[...LAYERS].reverse().map((layer, i) => (
        <div data-t={live ? `lr-${i}` : undefined} key={layer}>
          <KeyValueRow description={copy.lives[layer]} label={<Typo.Code>{zToken(layer)}</Typo.Code>} value={zValue(layer)} />
        </div>
      ))}
    </div>
  );
}

/** The window and, beside it, the ladder the window slides to make room for: one element, so the window on the finale is the very one that was taken apart. */
export function Ending({ copy, g }: { copy: LayersCopy; g: SceneGeometry | null }) {
  return (
    <div className={s.ending}>
      <Screen copy={copy} g={g} live />
      <div className={s.ladderBox} data-m="ladder">
        <Ladder copy={copy} live />
      </div>
    </div>
  );
}
