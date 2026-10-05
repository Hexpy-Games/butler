import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { createWallpaperEngine, type WallpaperEngine } from "./engine";
import { useWallpaperImageLoader } from "./imageLoaderContext";
import { WALLPAPER_IMAGE_MODULE } from "./modules";
import { resolveWallpaperScene, wallpaperSourceKey, wallpaperSourceTransparent } from "./registry";
import { useWallpaperErrorReporter, useWallpaperRegistry } from "./registryContext";
import type { WallpaperSource } from "./types";
import type { WallpaperProps } from "./wallpaperProps";
import { useWallpaperTone } from "./wallpaperTone";
import styles from "./Wallpaper.module.css";

export type { WallpaperProps } from "./wallpaperProps";

function moduleId(source: WallpaperSource): string {
  if (source.kind === "none") return "none";
  if (source.kind === "live") return source.module;
  return source.filter?.module ?? WALLPAPER_IMAGE_MODULE.manifest.id;
}

function WallpaperCanvas({
  source,
  motion = "auto",
  pauseOnBattery = false,
  tone: explicitTone,
  scope = "viewport",
  contentRect,
  registry: explicitRegistry,
  imageLoader,
  onError,
  dataTestClass,
  className,
  style,
  transparent,
}: WallpaperProps & { transparent: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<WallpaperEngine | null>(null);
  const registry = useWallpaperRegistry(explicitRegistry);
  const report = useWallpaperErrorReporter();
  const onErrorRef = useRef(onError);
  const reportRef = useRef(report);
  const loader = useWallpaperImageLoader(imageLoader);
  const loaderRef = useRef(loader);
  const tone = useWallpaperTone(canvasRef, explicitTone);
  // Content key: a new but equal source object never rebuilds anything.
  const sourceKey = wallpaperSourceKey(source);

  useEffect(() => {
    onErrorRef.current = onError;
    reportRef.current = report;
    loaderRef.current = loader;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const engine = createWallpaperEngine(canvas, {
      onError: (error) => {
        onErrorRef.current?.(error);
        reportRef.current?.(error);
      },
      // Read at load time, so a new loader function never rebuilds the engine.
      imageLoader: (asset, variant) => (loaderRef.current ? loaderRef.current(asset, variant) : Promise.reject(new Error("No imageLoader"))),
      overlay: overlayRef.current,
      transparent,
    });
    engineRef.current = engine;
    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, [transparent]);

  useEffect(() => {
    engineRef.current?.setScene(resolveWallpaperScene(JSON.parse(sourceKey) as WallpaperSource, registry, tone));
  }, [sourceKey, registry, tone]);

  useEffect(() => {
    engineRef.current?.setMotion(motion, pauseOnBattery);
  }, [motion, pauseOnBattery]);

  // By value: a new but equal rect object never redraws.
  const { x, y, width, height } = contentRect ?? { x: 0, y: 0, width: 0, height: 0 };
  const hasContentRect = contentRect !== undefined;
  useEffect(() => {
    engineRef.current?.setContentRect(hasContentRect ? { x, y, width, height } : null);
  }, [hasContentRect, x, y, width, height]);

  const layerClass = cn(styles.root, scope === "container" ? styles.container : styles.viewport, className);
  return (
    <>
      <canvas
        aria-hidden="true"
        className={layerClass}
        data-module={moduleId(source)}
        data-scope={scope}
        data-test-class={dataTestClass ? `wallpaper ${dataTestClass}` : "wallpaper"}
        data-tone={tone}
        data-transparent={transparent ? "" : undefined}
        ref={canvasRef}
        style={style}
      />
      {/* Crossfade: the previous frame, frozen and fading out over the canvas. */}
      <canvas aria-hidden="true" className={layerClass} hidden ref={overlayRef} style={style} />
    </>
  );
}

/**
 * The app wallpaper: a live WebGL2 module, an image, or nothing, drawn behind
 * content under the engine's performance and motion policy. Another module or
 * image crossfades; params and image options redraw in place. Once something
 * has shown, `none` keeps the (cleared) canvas so the last frame fades out and
 * the next source fades in.
 */
export function Wallpaper(props: WallpaperProps) {
  const [shown, setShown] = useState(props.source.kind !== "none");
  const registry = useWallpaperRegistry(props.registry);
  // A `transparent` module needs a see-through canvas, and a canvas keeps its context attributes, so the mode keys
  // the canvas (switching mode remounts it, without a crossfade). `none` keeps the last mode so its frame fades out.
  const wanted = props.source.kind === "none" ? null : wallpaperSourceTransparent(props.source, registry);
  const [transparent, setTransparent] = useState(wanted === true);
  if (props.source.kind !== "none" && !shown) setShown(true);
  if (wanted !== null && wanted !== transparent) setTransparent(wanted);
  if (!shown) return null;
  return <WallpaperCanvas key={transparent ? "transparent" : "opaque"} {...props} transparent={transparent} />;
}
