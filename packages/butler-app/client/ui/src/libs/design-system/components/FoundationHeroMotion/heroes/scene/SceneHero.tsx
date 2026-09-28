import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { compileTimeline } from "../../heroTimeline";
import { CANVAS, col, gridVars, type HeroLayout } from "../shared/grid";
import { useFrame } from "../shared/useFrame";
import { measureScene } from "./measureScene";
import { sceneTracks } from "./sceneTimeline";
import type { SceneGeometry, SceneSpec } from "./types";
import c from "../shared/ChapterHero.module.css";
import s from "./SceneHero.module.css";

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

/** The static geometry the timeline is compiled against, measured again when copy, canvas or a scene's size changes. */
function useGeometry(root: RefObject<HTMLElement | null>, layout: HeroLayout, lang: FoundationHeroLang, ready: boolean) {
  const [geometry, setGeometry] = useState<SceneGeometry | null>(null);
  useLayoutEffect(() => setGeometry(null), [lang, layout, ready]);
  useLayoutEffect(() => {
    if (geometry || !ready || !root.current) return;
    setGeometry(measureScene(root.current, layout));
  }, [geometry, ready, root, layout]);
  useEffect(() => {
    const parts = ['[data-t="prelude"]', '[data-t="poster"]'].map((selector) => root.current?.querySelector(selector)).filter(Boolean) as Element[];
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
 * A v3 Foundations chapter hero (see types.ts): the chapter's own scenes on a
 * one-axis camera path, then a finale where the poster's tiles, packed edge
 * to edge by the chapter's grid, fly in from the frame's nearest edges and
 * hold. The static layout is the poster (reduced motion).
 */
export function SceneHero({ spec, lang }: { spec: SceneSpec; lang: FoundationHeroLang }) {
  const root = useRef<HTMLDivElement>(null);
  const scope = `sh${useId().replace(/[^a-z0-9]/giu, "")}`;
  const frame = useFrame(root, true);
  const ready = useFontsReady();
  const { layout } = frame;
  const g = useGeometry(root, layout, lang, ready);
  const compiled = useMemo(() => (g ? sceneTracks(spec, g) : null), [g, spec]);
  const css = useMemo(() => (compiled ? compileTimeline(scope, compiled.beats, compiled.tracks) : ""), [compiled, scope]);
  const still = compiled?.still;
  const grid = spec.poster[layout];
  const zoom = spec.posterZoom?.[layout] ?? (layout === "wide" ? 1 : 1.2);
  const style = {
    ...gridVars(layout),
    "--fit": frame.fit,
    "--poster-zoom": zoom,
    "--canvas-w": `${CANVAS[layout].w}px`,
    "--canvas-h": `${CANVAS[layout].h}px`,
    "--col": `${col(layout, 1).w}px`,
    inlineSize: `${CANVAS[layout].w}px`,
    blockSize: `${CANVAS[layout].h}px`,
  } as CSSProperties;
  const posterGrid = { gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows, gridTemplateAreas: grid.areas.map((row) => `"${row}"`).join(" ") } as CSSProperties;
  return (
    <div className={c.board} data-hero-scope={scope} data-layout={layout} data-marks={compiled?.marks.join(" ")} data-ready={css ? "" : undefined} inert lang={lang} ref={root} style={style}>
      {css ? <style>{css}</style> : null}
      <div className={c.camera}>
        {/* The still poster (reduced motion) rests on the finale's framing. */}
        <div className={`${c.world} ${s.world}`} data-t="world" style={still ? { transform: `translate(${still.x ?? 0}px, ${still.y ?? 0}px) scale(${still.s ?? 1})` } : undefined}>
          <div className={`${c.prelude} ${s.prelude}`} data-t="prelude">
            {spec.scenes.map((name) => {
              const region = spec.regions[name];
              return <div className={`${c.cell} ${s.cell}`} data-cell={name} key={name}>{typeof region === "function" ? region(g) : region}</div>;
            })}
          </div>
          <div className={s.poster} data-layout={layout} data-t="poster" style={posterGrid}>
            {Object.entries(spec.tiles).map(([id, tile]) => (
              <div className={s.tile} data-t={`tile-${id}`} data-tile={id} key={id} style={{ gridArea: id }}>{tile}</div>
            ))}
          </div>
        </div>
      </div>
      {spec.hud ? <div className={s.hud}>{spec.hud}</div> : null}
    </div>
  );
}
