import type { WallpaperDrawFrame } from "../glDraw";
import { linkWallpaperModule } from "../glModule";
import type { WallpaperGpuResources } from "../glResources";
import { drawWallpaperScene } from "../glScene";
import type { WallpaperUniformValue } from "../glsl";
import { RISO_INTRO_MODULE } from "./introShaders";

/**
 * One frame of the first-run intro into the default framebuffer: its density pass into the shared quarter-resolution
 * target, then the riso print pass with the mark. Its programs live in the same cache as the modules, so they link
 * once per context (the engine draws the first frame before the reveal starts). False when they fail to link.
 */
export function drawWallpaperIntro(gl: WebGL2RenderingContext, resources: WallpaperGpuResources, frame: WallpaperDrawFrame, uniforms: WallpaperUniformValue[]): boolean {
  if (gl.isContextLost()) return false;
  const { result } = linkWallpaperModule(resources.programs, RISO_INTRO_MODULE, resources.precision);
  if (!result.ok || !result.density) return false;
  const scene = { compiled: result.base, overlay: null, density: result.density, module: RISO_INTRO_MODULE, uniforms, dark: false, image: null, revision: 0 };
  drawWallpaperScene(gl, resources, scene, frame);
  return true;
}
