// Built-in wallpaper modules. Each lives in `<id>/wallpaper.json` + `<id>/shader.frag`
// (+ `overlay.frag` for two-pass modules, + its `defaultImage`), the same format user
// modules use, and goes through the same validation.
import { bundledWallpaperImage } from "../imageCache";
import { defineWallpaperModule } from "../manifest";
import bloomManifest from "./butler.bloom/wallpaper.json";
import bloomFragment from "./butler.bloom/shader.frag?raw";
import diatomManifest from "./butler.diatom/wallpaper.json";
import diatomOverlay from "./butler.diatom/overlay.frag?raw";
import diatomFragment from "./butler.diatom/shader.frag?raw";
import duskManifest from "./butler.dusk/wallpaper.json";
import duskFragment from "./butler.dusk/shader.frag?raw";
import grainManifest from "./butler.grain/wallpaper.json";
import grainFragment from "./butler.grain/shader.frag?raw";
import imageManifest from "./butler.image/wallpaper.json";
import imageFragment from "./butler.image/shader.frag?raw";
import laminaManifest from "./butler.lamina/wallpaper.json";
import laminaFragment from "./butler.lamina/shader.frag?raw";
import cloudsPhoto from "./butler.photo-clouds/photo.jpg";
import cloudsFragment from "./butler.photo-clouds/shader.frag?raw";
import cloudsManifest from "./butler.photo-clouds/wallpaper.json";
import daisiesPhoto from "./butler.photo-daisies/photo.jpg";
import daisiesFragment from "./butler.photo-daisies/shader.frag?raw";
import daisiesManifest from "./butler.photo-daisies/wallpaper.json";
import risoFragment from "./butler.riso-flow/shader.frag?raw";
import risoManifest from "./butler.riso-flow/wallpaper.json";
import shorelineFragment from "./butler.shoreline/shader.frag?raw";
import shorelineManifest from "./butler.shoreline/wallpaper.json";
import silkManifest from "./butler.silk/wallpaper.json";
import silkFragment from "./butler.silk/shader.frag?raw";
import stippleOverlay from "./butler.stipple/overlay.frag?raw";
import stipplePhoto from "./butler.stipple/photo.jpg";
import stippleFragment from "./butler.stipple/shader.frag?raw";
import stippleManifest from "./butler.stipple/wallpaper.json";

export const BLOOM_WALLPAPER = defineWallpaperModule({ manifest: bloomManifest, fragment: bloomFragment });
export const SILK_WALLPAPER = defineWallpaperModule({ manifest: silkManifest, fragment: silkFragment });

// The analog collection. `stillTime` is the moment picker thumbnails show; the photos'
// `luminance` (average relative luminance, measured like an upload's) sets their dim
// (none for the living photos below: theirs rounds under the skipped 0.05).
/** Risograph halftone seen through a loupe: three ink waves flowing. */
export const RISO_FLOW_WALLPAPER = defineWallpaperModule({ manifest: risoManifest, fragment: risoFragment, stillTime: 20 });
/** Moss leaf chloroplasts under a microscope, the lower half leaf, the top clear. */
export const LAMINA_WALLPAPER = defineWallpaperModule({ manifest: laminaManifest, fragment: laminaFragment, stillTime: 2 });
/** A diatom valve (two-pass: the valve is cached, debris and grain move over it). */
export const DIATOM_WALLPAPER = defineWallpaperModule({ manifest: diatomManifest, fragment: diatomFragment, overlay: diatomOverlay, stillTime: 6 });
/** A horizon at dawn (light) or dusk (dark), city lights drawing closer. */
export const DUSK_WALLPAPER = defineWallpaperModule({ manifest: duskManifest, fragment: duskFragment, stillTime: 10 });
/** A shoreline from the air; `realtime` makes its light, and the app theme, follow the clock (`sceneTone`). */
export const SHORELINE_WALLPAPER = defineWallpaperModule({ manifest: shorelineManifest, fragment: shorelineFragment, stillTime: 8 });
/** Living photo: sunset clouds billowing, a bird in flight. */
export const PHOTO_CLOUDS_WALLPAPER = defineWallpaperModule({
  manifest: cloudsManifest, fragment: cloudsFragment, defaultImage: bundledWallpaperImage(cloudsPhoto, 0.245), stillTime: 20,
});
/** Living photo: a daisy field with light through leaves and a breeze. */
export const PHOTO_DAISIES_WALLPAPER = defineWallpaperModule({
  manifest: daisiesManifest, fragment: daisiesFragment, defaultImage: bundledWallpaperImage(daisiesPhoto, 0.297), stillTime: 6,
});
/**
 * One-tone stipple print (two-pass, device pixel ratio, never dimmed): an image
 * filter for the user's photos, also a live wallpaper on its sample photo.
 */
export const STIPPLE_WALLPAPER = defineWallpaperModule({
  manifest: stippleManifest, fragment: stippleFragment, overlay: stippleOverlay, defaultImage: bundledWallpaperImage(stipplePhoto, 0.14), stillTime: 20,
});

/** An image filter (`image: required`): film grain over the fitted image. */
export const GRAIN_WALLPAPER = defineWallpaperModule({ manifest: grainManifest, fragment: grainFragment });

/**
 * Draws `image` sources: fit, blur and the theme's neutral field (dim is an
 * engine pass after it). Also pre-fits the image for filter modules. Not
 * user-selectable.
 */
export const WALLPAPER_IMAGE_MODULE = defineWallpaperModule({ manifest: imageManifest, fragment: imageFragment });

/**
 * Built-ins in picker order: live modules first (the default, then the analog
 * collection and the living photos), then image filters (modules that take an image).
 */
export const BUILTIN_WALLPAPER_MODULES = [
  BLOOM_WALLPAPER,
  SILK_WALLPAPER,
  RISO_FLOW_WALLPAPER,
  LAMINA_WALLPAPER,
  DIATOM_WALLPAPER,
  DUSK_WALLPAPER,
  SHORELINE_WALLPAPER,
  PHOTO_CLOUDS_WALLPAPER,
  PHOTO_DAISIES_WALLPAPER,
  STIPPLE_WALLPAPER,
  GRAIN_WALLPAPER,
] as const;
