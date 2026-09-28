import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { FoundationHeroLang } from "../FoundationHeroMotion";
import { compileTimeline } from "../heroTimeline";
import { CANVAS, measureType, TALL_BELOW, type TypeLayout, type TypeMeasure } from "./typography/measureType";
import { ProductBoard } from "./typography/ProductBoard";
import { RoleLadder } from "./typography/RoleLadder";
import { typeTracks } from "./typography/typeAssembly";
import { BEATS, select } from "./typography/typeChoreography";
import { TYPE_COPY } from "./typography/typeCopy";
import { Glyph, SpecimenOverlay } from "./typography/TypeSpecimen";
import t from "./typography/TypographyHero.module.css";

/** Layout and fit scale of the canvas in its stage. */
function useFrame(root: React.RefObject<HTMLElement | null>) {
  const [frame, setFrame] = useState<{ layout: TypeLayout; fit: number }>({ layout: "wide", fit: 1 });
  useLayoutEffect(() => {
    const stage = root.current?.parentElement;
    if (!stage) return undefined;
    const update = () => {
      const layout: TypeLayout = stage.clientWidth < TALL_BELOW ? "tall" : "wide";
      const canvas = CANVAS[layout];
      const fit = Math.round(Math.min(stage.clientWidth / canvas.w, stage.clientHeight / canvas.h) * 1000) / 1000 || 1;
      setFrame((current) => (current.layout === layout && current.fit === fit ? current : { layout, fit }));
    };
    update();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [root]);
  return frame;
}

/**
 * The poster geometry the timeline is compiled against: measured once the
 * fonts are ready, and again when the copy, the canvas or a component's size
 * changes (theme, density, font). Until then the still poster shows.
 */
function useTypeMeasure(root: React.RefObject<HTMLElement | null>, layout: TypeLayout, lang: FoundationHeroLang, words: number) {
  const [measure, setMeasure] = useState<TypeMeasure | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts) setFontsReady(true);
    else void fonts.ready.then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);
  useLayoutEffect(() => setMeasure(null), [lang, layout]);
  useLayoutEffect(() => {
    if (measure || !fontsReady || !root.current) return;
    setMeasure(measureType(root.current, layout, words));
  }, [measure, fontsReady, root, layout, words]);
  useEffect(() => {
    const parts = [select("ladder"), select("product")].map((selector) => root.current?.querySelector(selector)).filter(Boolean) as Element[];
    if (!measure || typeof ResizeObserver !== "function" || parts.length === 0) return undefined;
    const sizes = new Map<Element, string>();
    const observer = new ResizeObserver((entries) => {
      const changed = entries.some((entry) => {
        const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        const before = sizes.get(entry.target);
        sizes.set(entry.target, size);
        return before !== undefined && before !== size;
      });
      if (changed) setMeasure(null);
    });
    for (const part of parts) observer.observe(part);
    return () => observer.disconnect();
  }, [measure, root]);
  return measure;
}

/**
 * 02 Typography, "from token to product": the typeface and its weight axis,
 * the role scale in depth with its leading, tabular numerals, then each role's
 * text flies into real Butler components (settings, a conversation turn, a
 * dashboard metric, the composer) under a moving camera, and settles into the
 * composed poster. The poster (reduced motion) is the static layout itself:
 * the tokens beside the assembled components. See typeChoreography.ts.
 */
export function TypographyHero({ lang }: { lang: FoundationHeroLang }) {
  const copy = TYPE_COPY[lang];
  const root = useRef<HTMLDivElement>(null);
  const scope = `th${useId().replace(/[^a-z0-9]/giu, "")}`;
  const frame = useFrame(root);
  const words = copy.placeholder.split(" ").length;
  const measure = useTypeMeasure(root, frame.layout, lang, words);
  const css = useMemo(() => (measure ? compileTimeline(scope, BEATS, typeTracks(measure.geometry)) : ""), [measure, scope]);
  const canvas = CANVAS[frame.layout];
  const style = { "--fit": frame.fit, inlineSize: `${canvas.w}px`, blockSize: `${canvas.h}px` } as CSSProperties;
  return (
    <div className={t.board} data-hero-scope={scope} data-layout={frame.layout} data-ready={css ? "" : undefined} inert lang={lang} ref={root} style={style}>
      {css ? <style>{css}</style> : null}
      <div className={t.camera}>
        <div className={t.world} data-t="world">
          <div className={t.tokens}>
            <div className={t.specimenRow}>
              <Glyph />
              <span className={t.family} data-t="family">
                <span>Pretendard Variable</span>
                <span className={t.mono}>45–920</span>
              </span>
            </div>
            <RoleLadder copy={copy} specs={measure?.specs ?? {}} />
          </div>
          <ProductBoard copy={copy} />
          <SpecimenOverlay copy={copy} />
        </div>
      </div>
    </div>
  );
}
