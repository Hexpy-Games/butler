import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { WallpaperRegistry } from "./registry";
import type {
  WallpaperContentRect,
  WallpaperError,
  WallpaperImageLoader,
  WallpaperMotion,
  WallpaperScope,
  WallpaperSource,
  WallpaperTone,
} from "./types";

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
   * Unknown module, compile/link failure (the default module is shown instead; a transparent module's canvas stays empty),
   * image load failure (default module), filter without image input (plain image), no WebGL2,
   * a watchdog degrade or a lost context. The provider's `onError` hears them too.
   */
  onError?: (error: WallpaperError) => void;
  /** Added to the `wallpaper` test class. */
  dataTestClass?: string;
}
