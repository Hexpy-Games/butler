import { useEffect, useRef, useState } from "react";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import { createWallpaperEngine, type WallpaperEngine } from "./engine";
import { useWallpaperImageLoader } from "./imageLoaderContext";
import { WALLPAPER_IMAGE_MODULE } from "./modules";
import { resolveWallpaperScene, wallpaperSourceKey, type WallpaperRegistry } from "./registry";
import { useWallpaperErrorReporter, useWallpaperRegistry } from "./registryContext";
import type {
  WallpaperContentRect,
  WallpaperError,
  WallpaperImageLoader,
  WallpaperMotion,
  WallpaperScope,
  WallpaperSource,
  WallpaperTone,
} from "./types";
import { useWallpaperTone } from "./wallpaperTone";
import styles from "./Wallpaper.module.css";

export interface WallpaperProps extends DsPrivateStyleProps {
  /** What to draw; `none` renders nothing. */
  source: WallpaperSource;
  /** `paused` holds a still frame (the user's pause). */
  motion?: WallpaperMotion;
  /** Hold a still frame while the device runs on battery. */
  pauseOnBattery?: boolean;
  /** Omit to follow the nearest theme scope, live. */
  tone?: WallpaperTone;
  /** `viewport`: fixed full-screen layer. `container`: fills the nearest positioned parent. */
  scope?: WallpaperScope;
  /**
   * The main text/content area in client CSS px (e.g. its `getBoundingClientRect()`),
   * exposed to modules as `u_contentRect` so they can compose around the text.
   */
  contentRect?: WallpaperContentRect;
  /**
   * Modules for `source.module` and image filters; defaults to the nearest `WallpaperRegistryProvider`'s,
   * else the built-ins. A new registry re-resolves: a module's new shader crossfades in.
   */
  registry?: WallpaperRegistry;
  /** Loads `image` sources' bytes (the engine decodes, caches, uploads); defaults to the nearest `WallpaperImageLoaderProvider`. */
  imageLoader?: WallpaperImageLoader;
  /**
   * Unknown module, compile/link failure (the default module is shown instead),
   * image load failure (default module), filter without image input (plain image), no WebGL2,
   * a watchdog degrade or a lost context. The provider's `onError` hears them too.
   */
  onError?: (error: WallpaperError) => void;
  /** Added to the `wallpaper` test class. */
  dataTestClass?: string;
}

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
}: WallpaperProps) {
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
    });
    engineRef.current = engine;
    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

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
  if (props.source.kind !== "none" && !shown) setShown(true);
  if (!shown) return null;
  return <WallpaperCanvas {...props} />;
}
