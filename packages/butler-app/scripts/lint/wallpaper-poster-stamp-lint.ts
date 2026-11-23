// The wallpaper poster stamp (posters/inputs.json) matches its inputs; vite build checks it too.
import { resolve } from "node:path";
import { checkWallpaperPosters } from "../../client/ui/scripts/check-wallpaper-posters";

checkWallpaperPosters(resolve(import.meta.dir, "../../client/ui"));
