import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import { compileTimeline } from "../../heroTimeline";
import { measureScene } from "../scene/measureScene";
import type { SceneGeometry } from "../scene/types";
import { CANVAS, col, gridVars, type HeroLayout } from "../shared/grid";
import { useFrame } from "../shared/useFrame";
import type { IconCopy } from "./iconCopy";
import { SCENES, iconTimeline } from "./iconTracks";
import c from "../shared/ChapterHero.module.css";
import s from "./IconHero.module.css";

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
    const prelude = root.current?.querySelector('[data-t="prelude"]');
    if (!geometry || typeof ResizeObserver !== "function" || !prelude) return undefined;
    let before: string | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const size = `${Math.round(entry!.contentRect.width)}x${Math.round(entry!.contentRect.height)}`;
      if (before !== undefined && before !== size) setGeometry(null);
      before = size;
    });
    observer.observe(prelude);
    return () => observer.disconnect();
  }, [geometry, root]);
  return geometry;
}

/**
 * The Iconography stage. Built like the scene heroes (SceneHero: the same
 * canvas, grid, one-axis camera path, measuring and compiled timeline), but
 * its last scene is its poster: the icon set on a grid filling the frame,
 * which the camera pulls out over while it draws, so there are no tiles to
 * gather. At rest (reduced motion) the world stands at the canvas: the grid.
 */
export function IconStage({ copy, lang, regions }: { copy: IconCopy; lang: FoundationHeroLang; regions: (layout: HeroLayout) => Record<(typeof SCENES)[number], ReactNode> }) {
  const root = useRef<HTMLDivElement>(null);
  const scope = `ih${useId().replace(/[^a-z0-9]/giu, "")}`;
  const frame = useFrame(root, true);
  const ready = useFontsReady();
  const { layout } = frame;
  const g = useGeometry(root, layout, lang, ready);
  const compiled = useMemo(() => (g ? iconTimeline(copy, g) : null), [g, copy]);
  const css = useMemo(() => (compiled ? compileTimeline(scope, compiled.beats, compiled.tracks) : ""), [compiled, scope]);
  const scenes = regions(layout);
  const style = {
    ...gridVars(layout),
    "--fit": frame.fit,
    "--canvas-w": `${CANVAS[layout].w}px`,
    "--canvas-h": `${CANVAS[layout].h}px`,
    "--col": `${col(layout, 1).w}px`,
    inlineSize: `${CANVAS[layout].w}px`,
    blockSize: `${CANVAS[layout].h}px`,
  } as CSSProperties;
  return (
    <div className={c.board} data-hero-scope={scope} data-layout={layout} data-marks={compiled?.marks.join(" ")} data-ready={css ? "" : undefined} inert lang={lang} ref={root} style={style}>
      {css ? <style>{css}</style> : null}
      <div className={c.camera}>
        <div className={c.world} data-t="world">
          <div className={c.prelude} data-t="prelude">
            {SCENES.map((name) => (
              <div className={`${c.cell} ${name === "grid" ? s.posterCell : ""}`} data-cell={name} key={name}>{scenes[name]}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
