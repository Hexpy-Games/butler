import { createContext, useContext, useMemo, type ReactNode } from "react";
import { BUILTIN_WALLPAPERS, type WallpaperRegistry } from "./registry";
import type { WallpaperError, WallpaperUserModule } from "./types";

interface WallpaperRegistryContextValue {
  registry: WallpaperRegistry;
  userModules: readonly WallpaperUserModule[];
  onError?: (error: WallpaperError) => void;
}

const NO_USER_MODULES: readonly WallpaperUserModule[] = [];
const WallpaperRegistryContext = createContext<WallpaperRegistryContextValue>({ registry: BUILTIN_WALLPAPERS, userModules: NO_USER_MODULES });

export interface WallpaperRegistryProviderProps {
  /** What every `Wallpaper` and `WallpaperPicker` below resolves modules against (built-ins plus usable user modules). */
  registry: WallpaperRegistry;
  /** User modules in display order, usable or not; pickers list them after the built-ins. */
  userModules?: readonly WallpaperUserModule[];
  /** Every error of every `Wallpaper` below (besides its own `onError`), e.g. to retire a failing user module. */
  onError?: (error: WallpaperError) => void;
  children: ReactNode;
}

/** Supplies one module registry (and the user modules behind it) to every wallpaper and picker below. */
export function WallpaperRegistryProvider({ registry, userModules = NO_USER_MODULES, onError, children }: WallpaperRegistryProviderProps) {
  const value = useMemo(() => ({ registry, userModules, onError }), [registry, userModules, onError]);
  return <WallpaperRegistryContext.Provider value={value}>{children}</WallpaperRegistryContext.Provider>;
}

/** The explicit registry, else the nearest provider's, else the built-ins. */
export function useWallpaperRegistry(explicit?: WallpaperRegistry): WallpaperRegistry {
  const { registry } = useContext(WallpaperRegistryContext);
  return explicit ?? registry;
}

/** The nearest provider's user modules; none without a provider. */
export function useWallpaperUserModules(): readonly WallpaperUserModule[] {
  return useContext(WallpaperRegistryContext).userModules;
}

/** The nearest provider's error reporter. */
export function useWallpaperErrorReporter(): ((error: WallpaperError) => void) | undefined {
  return useContext(WallpaperRegistryContext).onError;
}
