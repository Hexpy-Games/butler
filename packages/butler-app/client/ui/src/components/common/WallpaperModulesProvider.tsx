import { useSyncExternalStore, type ReactNode } from "react";
import { userWallpaperModules } from "@/app/userWallpaperModules.ts";
import { loadWallpaperAssetImage } from "@/app/wallpaperAssets.ts";
import { WallpaperImageLoaderProvider, WallpaperRegistryProvider } from "@/butler-ds";

/**
 * What every wallpaper and picker below draws with: uploaded images load
 * through the gateway, and modules resolve against one registry (the
 * built-ins plus the user's usable modules). Wallpaper errors go back to the
 * store, which retires a user module that fails when drawn.
 */
export function WallpaperModulesProvider({ children }: { children: ReactNode }) {
  const { registry, userModules } = useSyncExternalStore(userWallpaperModules.subscribe, userWallpaperModules.getSnapshot);
  return (
    <WallpaperImageLoaderProvider loader={loadWallpaperAssetImage}>
      <WallpaperRegistryProvider registry={registry} userModules={userModules} onError={userWallpaperModules.handleError}>
        {children}
      </WallpaperRegistryProvider>
    </WallpaperImageLoaderProvider>
  );
}
