// One frame of a selected scene: image pre-fit, a two-pass module's cached base, the module pass, then dim.
import { NO_WALLPAPER_CONTENT_RECT } from "./contentRect";
import { drawWallpaperProgram, type WallpaperDrawFrame, type WallpaperDrawProgram, type WallpaperImageInput } from "./glDraw";
import type { CompiledWallpaperProgram } from "./glProgram";
import type { WallpaperGpuResources } from "./glResources";
import { buildWallpaperFragmentSource } from "./glsl";
import { wallpaperImageBrightness, wallpaperImageUniforms } from "./imageMath";
import { WALLPAPER_IMAGE_MODULE } from "./modules";
import type { WallpaperImageScene } from "./registry";

/** A scene with its linked programs. */
export interface WallpaperDrawScene extends WallpaperDrawProgram {
  /** `overlay.frag` of a two-pass module; `compiled` is then its base (shader.frag), drawn into a cache. */
  overlay: CompiledWallpaperProgram | null;
  image: WallpaperImageScene | null;
  /** Identity of this selection (module, values, tone, image options): a new one redraws the cached base. */
  revision: number;
}

/** Day-phase steps (15 min) at which a cached base that reads `u_dayPhase` redraws. */
const DAY_PHASE_BUCKETS = 96;

interface SceneImageInput extends WallpaperImageInput {
  /** What the bound image depends on, for caches drawn from it. */
  key: string;
}

/** The image fitted and blurred into a buffer-sized texture, redrawn only when an input changes. */
function prefit(gl: WebGL2RenderingContext, resources: WallpaperGpuResources, scene: WallpaperDrawScene, raw: WallpaperImageInput, frame: WallpaperDrawFrame): SceneImageInput {
  const image = scene.image!;
  const texture = resources.images.get(image.asset)!;
  const key = [image.asset, texture.variant, texture.generation, texture.width, texture.height, image.fit, image.blur, scene.dark, frame.width, frame.height].join("|");
  const target = resources.images.prefit(frame.width, frame.height, key, () => {
    const { result } = resources.programs.get(WALLPAPER_IMAGE_MODULE.manifest.id, buildWallpaperFragmentSource(WALLPAPER_IMAGE_MODULE, resources.precision));
    if (result.ok) drawWallpaperProgram(gl, resources, { compiled: result.compiled, module: WALLPAPER_IMAGE_MODULE, uniforms: [], dark: scene.dark }, frame, raw);
  });
  return { texture: target, aspect: frame.width / frame.height, has: true, key };
}

function imageInput(gl: WebGL2RenderingContext, resources: WallpaperGpuResources, scene: WallpaperDrawScene, frame: WallpaperDrawFrame): SceneImageInput {
  const { image, module } = scene;
  const texture = image ? resources.images.get(image.asset) : undefined;
  if (!image || !texture) return { texture: resources.image, aspect: 0, has: false, key: "none" };
  const raw = { texture: texture.texture, aspect: texture.width / texture.height, has: true, module: wallpaperImageUniforms(image, texture, frame) };
  // Filter modules read the pre-fitted image, so fit and blur look the same under every filter.
  return module === WALLPAPER_IMAGE_MODULE ? { ...raw, key: "raw" } : prefit(gl, resources, scene, raw, frame);
}

/** Everything a two-pass module's base reads besides the scene itself; an equal key reuses the cached base. */
function baseKey({ compiled, revision }: WallpaperDrawScene, frame: WallpaperDrawFrame, image: SceneImageInput): string {
  return [
    revision, frame.width, frame.height, frame.pixelRatio, frame.seed, image.key,
    compiled.usesContentRect ? (frame.contentRect ?? NO_WALLPAPER_CONTENT_RECT).join(",") : "",
    compiled.usesDayPhase ? Math.floor(frame.dayPhase * DAY_PHASE_BUCKETS) : "",
  ].join("|");
}

/**
 * Draws one frame into the default framebuffer. A two-pass module's
 * `shader.frag` is drawn at `u_time = 0` into a cached texture only when an
 * input changes (size, pixel ratio, contentRect, tone, day-phase step, seed,
 * params, the image or its options); its `overlay.frag` runs every frame over
 * it. Image scenes are dimmed last, as the module's `imageDim` says.
 */
export function drawWallpaperScene(gl: WebGL2RenderingContext, resources: WallpaperGpuResources, scene: WallpaperDrawScene, frame: WallpaperDrawFrame) {
  const image = imageInput(gl, resources, scene, frame);
  if (scene.overlay) {
    const base = resources.base.use(frame.width, frame.height, baseKey(scene, frame, image), () => {
      drawWallpaperProgram(gl, resources, scene, { ...frame, timeMs: 0 }, image);
    });
    drawWallpaperProgram(gl, resources, { ...scene, compiled: scene.overlay }, frame, image, base);
  } else {
    drawWallpaperProgram(gl, resources, scene, frame, image);
  }
  // Dim comes last, over the filter too, so readability does not depend on the module.
  if (scene.image) resources.images.dim(wallpaperImageBrightness(scene.image.dim, scene.dark, scene.module.manifest.imageDim));
}
