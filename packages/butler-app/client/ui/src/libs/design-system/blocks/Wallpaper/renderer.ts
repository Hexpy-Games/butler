import type { WallpaperDrawFrame } from "./glDraw";
import { linkWallpaperModule } from "./glModule";
import { createWallpaperResources } from "./glResources";
import { drawWallpaperScene, type WallpaperDrawScene } from "./glScene";
import { wallpaperParamUniforms } from "./glsl";
import { WALLPAPER_IMAGE_MODULE } from "./modules";
import { BUILTIN_WALLPAPERS, defaultWallpaperModule, type WallpaperScene } from "./registry";
import type { WallpaperError, WallpaperImageVariant, WallpaperModule, WallpaperModuleMotion, WallpaperPixelRatioMode } from "./types";
import { isSoftwareWallpaperRenderer, wallpaperRendererName } from "./softwareGl";
import { resolveWallpaperValues } from "./values";

export type { WallpaperDrawFrame } from "./glDraw";

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  desynchronized: true,
  // No copy per frame: the crossfade repaints the frame right before it snapshots it.
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

export interface WallpaperRenderer {
  /** Picks the scene's programs (linked once per module source) and its uniform values. */
  setScene(scene: WallpaperScene): void;
  /** Uploads a decoded image (mipmapped, edge-clamped); `setScene` again to draw with it. */
  setImage(asset: string, variant: WallpaperImageVariant, bitmap: ImageBitmap): void;
  /** The variant uploaded for an asset; null when it has no texture (never loaded, released or lost). */
  imageVariant(asset: string): WallpaperImageVariant | null;
  /** Deletes the textures of every asset not listed. */
  retainImages(assets: ReadonlySet<string>): void;
  /** Motion of the module actually drawn (the fallback's after a failure, the image module's while an image loads). */
  motion(): WallpaperModuleMotion;
  /** Pixel-ratio mode of the module actually drawn. */
  pixelRatio(): WallpaperPixelRatioMode;
  /** Id of the module actually drawn; null before a scene. */
  drawnModule(): string | null;
  /**
   * The context renders in software (SwiftShader, llvmpipe, …): compositing then
   * reads every frame back on the main thread, so the engine holds still frames.
   */
  softwareRendering(): boolean;
  usesDayPhase(): boolean;
  usesContentRect(): boolean;
  draw(frame: WallpaperDrawFrame): void;
  /** Rebuilds every GPU resource after `webglcontextrestored`; images must be uploaded again. */
  restore(): void;
  /** Frees every GPU object and loses the context (`WEBGL_lose_context`); the canvas cannot host a renderer again. */
  dispose(): void;
}

export function createWallpaperRenderer(
  canvas: HTMLCanvasElement,
  { onError, fallback = defaultWallpaperModule(BUILTIN_WALLPAPERS) }: { onError: (error: WallpaperError) => void; fallback?: WallpaperModule },
): WallpaperRenderer | null {
  const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
  if (!gl) return null;
  const software = isSoftwareWallpaperRenderer(wallpaperRendererName(gl));
  let resources = createWallpaperResources(gl);
  let scene: WallpaperScene | null = null;
  let active: WallpaperDrawScene | null = null;
  let revision = 0;

  const link = (module: WallpaperModule) => linkWallpaperModule(resources.programs, module, resources.precision);

  const select = () => {
    if (!scene) return;
    const { image, dark } = scene;
    const tone = dark ? "dark" : "light";
    // An image scene without its texture draws the image module's neutral field.
    let module = image && !resources.images.get(image.asset) ? WALLPAPER_IMAGE_MODULE : scene.module;
    let values = module === scene.module ? scene.values : {};
    const first = link(module);
    let result = first.result;
    if (!result.ok) {
      if (first.fresh) onError({ reason: result.stage, module: module.manifest.id, message: result.log });
      // A broken filter falls back to the plain image; a broken live module to the default.
      module = image ? WALLPAPER_IMAGE_MODULE : fallback;
      values = resolveWallpaperValues(module.manifest, {}, tone);
      result = link(module).result;
    }
    revision += 1;
    active = result.ok
      ? { compiled: result.base, overlay: result.overlay, module, uniforms: wallpaperParamUniforms(module.manifest, values), dark, image, revision }
      : null;
  };

  const uses = (flag: "usesDayPhase" | "usesContentRect") => Boolean(active && (active.compiled[flag] || active.overlay?.[flag]));

  return {
    setScene(next) {
      scene = next;
      select();
    },
    setImage: (asset, variant, bitmap) => resources.images.upload(asset, variant, bitmap),
    imageVariant: (asset) => resources.images.get(asset)?.variant ?? null,
    retainImages: (assets) => resources.images.retain(assets),
    motion: () => active?.module.manifest.motion ?? scene?.module.manifest.motion ?? "static",
    pixelRatio: () => active?.module.manifest.pixelRatio ?? "default",
    drawnModule: () => active?.module.manifest.id ?? null,
    softwareRendering: () => software,
    usesDayPhase: () => uses("usesDayPhase"),
    usesContentRect: () => uses("usesContentRect"),
    draw(frame) {
      if (!active) return;
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      drawWallpaperScene(gl, resources, active, frame);
    },
    restore() {
      resources = createWallpaperResources(gl);
      active = null;
      select();
    },
    dispose() {
      resources.programs.dispose();
      resources.images.dispose();
      resources.base.dispose();
      gl.deleteTexture(resources.noise);
      gl.deleteTexture(resources.image);
      gl.deleteVertexArray(resources.vao);
      active = null;
      // Hand the context back now instead of at garbage collection (browsers cap live contexts).
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
