import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { WallpaperEvent } from "./drift";
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
   * A second, softer keep-out in client CSS px (e.g. the composer): print modules keep about 30% ink there
   * (`u_contentRect2`).
   */
  contentRect2?: WallpaperContentRect;
  /**
   * The reading column in client CSS px (e.g. the message list's box): print modules keep their ink out of its
   * width, below its top, letting only a faint tail in. Changes ease over 300 ms (instantly under reduced
   * motion, low power or while hidden); omitted: no column (new chat).
   */
  columnRect?: WallpaperContentRect;
  /**
   * A one-shot event for drift modules (focus, newChat, thinking, done): a new `id` fires once. Focus after
   * 5 min away and on first paint is detected by the engine itself. Other modules ignore events.
   */
  event?: WallpaperEvent;
  /**
   * 0..0.95: one uniform layer of the theme's paper colour (`--riso-paper`) over the whole wallpaper, for live
   * modules and images behind reading content. 0 or omitted: none.
   */
  paperOverlay?: number;
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
