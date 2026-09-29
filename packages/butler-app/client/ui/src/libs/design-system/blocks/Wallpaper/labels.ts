import type { WallpaperLabel } from "./types";

/** The UI locale a manifest label is read in (`ko-KR` reads `ko`, anything else `en`). */
export type WallpaperLocale = "en-US" | "ko-KR";

/** A manifest `{ en, ko }` label in the UI locale. */
export function wallpaperLabelText(label: WallpaperLabel, locale: WallpaperLocale): string {
  return locale === "ko-KR" ? label.ko : label.en;
}

/** Unlabeled enum options and palette preset names show their value, capitalized. */
export function wallpaperTitleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
