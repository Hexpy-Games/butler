import { createContext, useContext, type ReactNode } from "react";
import type { WallpaperImageLoader } from "./types";

const WallpaperImageLoaderContext = createContext<WallpaperImageLoader | undefined>(undefined);

/**
 * Supplies the app's image loader to every `Wallpaper` below, including
 * those DS blocks render (e.g. `PromptSuggestionList`).
 */
export function WallpaperImageLoaderProvider({ loader, children }: { loader: WallpaperImageLoader; children: ReactNode }) {
  return <WallpaperImageLoaderContext.Provider value={loader}>{children}</WallpaperImageLoaderContext.Provider>;
}

/** The explicit loader, else the nearest provider's. */
export function useWallpaperImageLoader(explicit?: WallpaperImageLoader): WallpaperImageLoader | undefined {
  const provided = useContext(WallpaperImageLoaderContext);
  return explicit ?? provided;
}
