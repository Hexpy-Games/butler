import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { compileTimeline } from "../../heroTimeline";
import { Annotations } from "./Annotations";
import { CANVAS, col, gridVars, type HeroLayout } from "./grid";
import { measureChapter } from "./measureChapter";
import { Sketch } from "./Sketch";
import { buildFrames, chapterTracks, posterZoom } from "./timeline";
import type { ChapterSpec, Geometry } from "./types";
import { useFrame } from "./useFrame";
import c from "./ChapterHero.module.css";

/** Fonts ready (layout depends on them). */
function useFontsReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (fonts) void fonts.ready.then(() => live && setReady(true));
    else setReady(true);
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

/** The poster geometry the timeline is compiled against, measured again when copy, canvas or a part's size changes. */
function useGeometry(root: RefObject<HTMLElement | null>, layout: HeroLayout, spec: ChapterSpec, lang: FoundationHeroLang, ready: boolean) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  useLayoutEffect(() => setGeometry(null), [lang, layout, ready]);
  useLayoutEffect(() => {
    if (geometry || !ready || !root.current) return;
    setGeometry(measureChapter(root.current, layout, spec));
  }, [geometry, ready, root, layout, spec]);
  useEffect(() => {
    const parts = ['[data-t="field-mover"]', '[data-t="product"]', '[data-t="prelude"]'].map((selector) => root.current?.querySelector(selector)).filter(Boolean) as Element[];
    if (!geometry || typeof ResizeObserver !== "function" || parts.length === 0) return undefined;
    const sizes = new Map<Element, string>();
    const observer = new ResizeObserver((entries) => {
      const changed = entries.some((entry) => {
        const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        const before = sizes.get(entry.target);
        sizes.set(entry.target, size);
        return before !== undefined && before !== size;
      });
      if (changed) setGeometry(null);
    });
    for (const part of parts) observer.observe(part);
    return () => observer.disconnect();
  }, [geometry, root]);
  return geometry;
}

/**
 * A Foundations chapter hero on the shared engine: the chapter's own prelude
 * (its scenes, camera and token field), then real DS components built one at
 * a time under badges naming their tokens, and a finale that zooms out to the
 * poster (the reduced-motion still), the token field beside the product.
 * See types.ts for the contract.
 */
export function ChapterHero({ spec, lang }: { spec: ChapterSpec; lang: FoundationHeroLang }) {
  const root = useRef<HTMLDivElement>(null);
  const scope = `ch${useId().replace(/[^a-z0-9]/giu, "")}`;
  const frame = useFrame(root, true);
  const ready = useFontsReady();
  const g = useGeometry(root, frame.layout, spec, lang, ready);
  const compiled = useMemo(() => (g ? chapterTracks(spec, g) : null), [g, spec]);
  const css = useMemo(() => (compiled ? compileTimeline(scope, compiled.beats, compiled.tracks) : ""), [compiled, scope]);
  const { layout } = frame;
  const frames = g ? buildFrames(spec, g) : [];
  const style = {
    ...gridVars(layout, spec.fieldColumns ?? 4),
    "--fit": frame.fit,
    "--poster-zoom": posterZoom(spec, layout),
    "--canvas-w": `${CANVAS[layout].w}px`,
    "--canvas-h": `${CANVAS[layout].h}px`,
    "--col": `${col(layout, 1).w}px`,
    inlineSize: `${CANVAS[layout].w}px`,
    blockSize: `${CANVAS[layout].h}px`,
  } as CSSProperties;
  return (
    <div className={c.board} data-field={spec.fieldRight ? "right" : "left"} data-hero-scope={scope} data-layout={layout} data-marks={compiled?.marks.join(" ")} data-ready={css ? "" : undefined} inert lang={lang} ref={root} style={style}>
      {css ? <style>{css}</style> : null}
      <div className={c.camera}>
        <div className={c.world} data-t="world">
          <div className={c.prelude} data-t="prelude">
            {Object.entries(spec.prelude.regions).map(([name, region]) => (
              <div className={c.cell} data-cell={name} key={name}>{typeof region === "function" ? region(g) : region}</div>
            ))}
          </div>
          <div className={c.poster}>
            <div className={c.field} data-t="field-mover">{typeof spec.field === "function" ? spec.field(g) : spec.field}</div>
            <div className={`${c.product} ${spec.product}`} data-t="product">
              {spec.builds.map((build) => {
                const entry = frames.find((item) => item.build.id === build.id);
                return (
                  <div className={c.panel} data-panel={build.id} data-t={`panel-${build.id}`} key={build.id} style={{ gridArea: build.id }}>
                    <div className={c.surface} data-t={`surface-${build.id}`}>{build.render}</div>
                    {g ? <Sketch boxes={g.sketches[build.id] ?? []} id={build.id} /> : null}
                    {entry ? <Annotations items={entry.items.flat()} /> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
