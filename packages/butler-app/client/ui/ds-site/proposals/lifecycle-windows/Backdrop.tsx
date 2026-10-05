import { Wallpaper, type WallpaperContentRect } from "@/butler-ds";
import { builtinPosters } from "@/butler-ds/blocks/WallpaperPicker/builtinPosters";
import { SCENE_WALLPAPERS, wallpaperSource, type Backdrop, type WallpaperId } from "./state";

/**
 * The window backdrop.
 * - `still` (recommended): the real Wallpaper engine, paused, at the window's own size and DPR, i.e.
 *   exactly the still the app draws for this source and theme.
 * - `poster`: what codex/startup-splash ships today: the 320×200 picker poster, `object-fit: cover`.
 *   PROPOSAL-ONLY copy of that <img> (startup.css #wallpaper), kept to show the upscale blur.
 */
export function LifecycleBackdrop({ wallpaper, backdrop, theme, contentRect }: {
  wallpaper: WallpaperId; backdrop: Backdrop; theme: "light" | "dark"; contentRect?: WallpaperContentRect;
}) {
  if (backdrop === "still" || wallpaper === "none") {
    return <Wallpaper source={wallpaperSource(wallpaper)} motion="paused" scope="viewport" contentRect={contentRect} />;
  }
  const tone = SCENE_WALLPAPERS.includes(wallpaper) ? "light" : theme;
  const poster = builtinPosters[`${wallpaper}|${tone}`];
  return (
    <img
      alt=""
      src={poster}
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}
