import { appCopy } from "@/app/copy.ts";
import type { WallpaperPickerLabels } from "@/butler-ds";

/** The WallpaperPicker's copy in the current language (settings and project pickers alike). */
export function wallpaperPickerLabels(): WallpaperPickerLabels {
  const { wallpaper } = appCopy.settings;
  return {
    options: wallpaper.options, none: wallpaper.none, image: wallpaper.image, addImage: wallpaper.addImage, deleteImage: wallpaper.deleteImage,
    fit: wallpaper.fit, fill: wallpaper.fill, fitWhole: wallpaper.fitWhole, dim: wallpaper.dim, blur: wallpaper.blur,
    filter: wallpaper.filter, noFilter: wallpaper.noFilter, mine: wallpaper.mine,
    importModule: wallpaper.importModule, deleteModule: wallpaper.deleteModule,
  };
}
