import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wallpaperPosterInputs } from "./wallpaper-poster-inputs";

export function checkWallpaperPosters(root: string): void {
  const recorded = JSON.parse(readFileSync(resolve(root, "src/libs/design-system/blocks/WallpaperPicker/posters/inputs.json"), "utf8"));
  if (JSON.stringify(recorded) !== JSON.stringify(wallpaperPosterInputs(root))) {
    throw new Error("Wallpaper posters are stale. Run bun run packages/butler-app/client/ui/scripts/generate-wallpaper-posters.ts.");
  }
}
