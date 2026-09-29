import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useFrame } from "./shared/useFrame";
import type { FoundationHeroLang } from "../FoundationHeroMotion";
import { compileTimeline } from "../heroTimeline";
import { measureType, type TypeMeasure } from "./typography/measureType";
import { ProductBoard } from "./typography/ProductBoard";
import { Reveal } from "./typography/Reveal";
import { RoleLadder } from "./typography/RoleLadder";
import { measureSpecimen, POSTER_WEIGHT, specimenLayout, type SpecimenMetrics } from "./typography/specimenMetrics";
import { typeTracks } from "./typography/typeAssembly";
import { posterFit } from "./typography/typeCamera";
import { AXIS, BEATS, select } from "./typography/typeChoreography";
import { TYPE_COPY } from "./typography/typeCopy";
import { CANVAS, col, columnWidth, gridVars, SPECIMEN, type TypeLayout } from "./typography/typeGrid";
import { Specimen } from "./typography/Specimen";
import { WeightControl } from "./typography/WeightControl";
import t from "./typography/TypographyHero.module.css";

/** Poster height of the specimen's em box (px), on the baseline grid. */
const POSTER_EM: Record<TypeLayout, number> = { wide: 72, tall: 56 };

const axisAt = (weight: number) => (weight - AXIS.min) / (AXIS.max - AXIS.min);

/** Fonts ready, then the specimen's real metrics from the live font stack. */
function useSpecimenMetrics(root: RefObject<HTMLElement | null>) {
  const [metrics, setMetrics] = useState<SpecimenMetrics | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      const node = root.current;
      if (!live || !node) return;
      const style = getComputedStyle(node);
      setMetrics(measureSpecimen(style.fontFamily, Number.parseFloat(style.getPropertyValue("--typo-new-chat-title-letter-spacing")) || 0));
    };
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (fonts) void fonts.ready.then(read);
    else read();
    return () => {
      live = false;
    };
  }, [root]);
  return metrics;
}

/** The poster geometry the timeline is compiled against, measured again when copy, canvas or a component's size changes. */
function useTypeMeasure(root: RefObject<HTMLElement | null>, layout: TypeLayout, lang: FoundationHeroLang, ready: boolean) {
  const [measure, setMeasure] = useState<TypeMeasure | null>(null);
  useLayoutEffect(() => setMeasure(null), [lang, layout, ready]);
  useLayoutEffect(() => {
    if (measure || !ready || !root.current) return;
    setMeasure(measureType(root.current, layout));
  }, [measure, ready, root, layout]);
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
 * 02 Typography, "from token to product": the specimen "A가" drawn in a type
 * designer's working view (outlines, metrics, values), filled, then pushed
 * along the weight axis with its guides and readout; it becomes the H2 role
 * of a scale that flies, role by role, into real Butler components. The
 * poster (reduced motion) is the static layout: tokens beside the product.
 * See typeChoreography.ts for the beats and typeGrid.ts for the grid.
 */
export function TypographyHero({ lang }: { lang: FoundationHeroLang }) {
  const copy = TYPE_COPY[lang];
  const root = useRef<HTMLDivElement>(null);
  const scope = `th${useId().replace(/[^a-z0-9]/giu, "")}`;
  const frame = useFrame(root);
  const metrics = useSpecimenMetrics(root);
  const measure = useTypeMeasure(root, frame.layout, lang, Boolean(metrics));
  const css = useMemo(() => (measure && metrics ? compileTimeline(scope, BEATS, typeTracks(measure.geometry, metrics)) : ""), [measure, metrics, scope]);
  const { layout } = frame;
  const rest = measure && layout === "tall" ? posterFit(measure.geometry) : undefined;
  const size = SPECIMEN[layout].size;
  const box = metrics ? specimenLayout(metrics, size, POSTER_WEIGHT) : null;
  const q = box ? POSTER_EM[layout] / box.height : 1;
  const style = {
    ...gridVars(layout),
    "--fit": frame.fit,
    "--rung-tag": `${columnWidth(layout)}px`,
    "--rung-spec": `${col(layout, 1, layout === "wide" ? 2 : 1).w}px`,
    "--control-w": `${col(layout, 1, 4).w}px`,
    inlineSize: `${CANVAS[layout].w}px`,
    blockSize: `${CANVAS[layout].h}px`,
  } as CSSProperties;
  const slot = box ? { "--slot-w": `${box.width * q}px`, "--slot-h": `${box.height * q}px`, "--spec-q": q } as CSSProperties : undefined;
  return (
    <div className={t.board} data-hero-scope={scope} data-layout={layout} data-ready={css ? "" : undefined} inert lang={lang} ref={root} style={style}>
      {css ? <style>{css}</style> : null}
      <div className={t.camera}>
        {/* The still poster (reduced motion) rests on the finale's framing (the whole poster on the tall canvas). */}
        <div className={t.world} data-t="world" style={rest ? { transform: `translate(${rest.x ?? 0}px, ${rest.y ?? 0}px) scale(${rest.s ?? 1})` } : undefined}>
          <div className={t.poster}>
            <div className={t.tokens}>
              <div className={t.specimenRow} data-t="specimen-row">
                <div className={t.specimenSlot} data-t="slot" style={slot}>
                  {metrics ? <Specimen compact={layout === "tall"} lineWidth={col(layout, 1, SPECIMEN[layout].span).w} metrics={metrics} size={size} /> : null}
                </div>
                <span className={t.family} data-t="family" style={{ "--family-drop": `${box ? metrics!.descender * size * q : 0}px` } as CSSProperties}>
                  <span><Reveal name="rv-family">Pretendard Variable</Reveal></span>
                  <span className={t.mono}><Reveal name="rv-axis">{`${AXIS.min}–${AXIS.max}`}</Reveal></span>
                </span>
              </div>
              <RoleLadder copy={copy} specs={measure?.specs ?? {}} />
            </div>
            <ProductBoard copy={copy} layout={layout} lines={measure?.geometry.lines ?? []} sketches={measure?.geometry.sketches ?? {}} />
          </div>
          <WeightControl axisAt={axisAt} />
          <span className={t.overlay} data-t="cap-tnum"><span className={t.mono}><Reveal name="rv-tnum">font-variant-numeric: tabular-nums</Reveal></span></span>
        </div>
      </div>
    </div>
  );
}
