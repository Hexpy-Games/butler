import {
  DEFAULT_PROMPT_FLUID_PALETTE,
  type FluidPalette,
} from "./promptFluidPalettes";
import {
  BLOOM_FRAGMENT_SHADER,
  SILK_FRAGMENT_SHADER,
  VERTEX_SHADER,
} from "./promptFluidShaders";
export {
  DEFAULT_PROMPT_FLUID_PALETTE,
  INDIGO_COLOR,
  PROMPT_FLUID_COLOR_COUNT,
  PROMPT_FLUID_PALETTE_PRESET_IDS,
  PROMPT_FLUID_PALETTES,
  VIOLET_COLOR,
  fluidPaletteFromHexColors,
  fluidPaletteToHexColors,
  fluidRgbToHex,
  type FluidPalette,
  type PromptFluidPalettePresetId,
  type FluidRgb,
} from "./promptFluidPalettes";

type FluidRenderer = {
  dispose: () => void;
  draw: (time?: number) => void;
};
export type FluidTone = "dark" | "light";
export type FluidVariant = "bloom" | "silk";

export const VISIBLE_LIQUID_SATURATION = 24;
const MAX_FLUID_CANVAS_PIXELS = 1_400_000;
const MAX_FLUID_PIXEL_RATIO = 1;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function createProgram(
  gl: WebGLRenderingContext,
  fragmentSource = BLOOM_FRAGMENT_SHADER,
) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = vertex && fragment ? gl.createProgram() : null;
  if (!program || !vertex || !fragment) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  gl: WebGLRenderingContext,
): void {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = rect.width || window.innerWidth;
  const cssHeight = rect.height || window.innerHeight;
  const baseRatio = Math.min(
    window.devicePixelRatio || 1,
    MAX_FLUID_PIXEL_RATIO,
  );
  const targetPixels = Math.max(1, cssWidth * cssHeight * baseRatio * baseRatio);
  const budgetRatio = Math.min(
    baseRatio,
    Math.sqrt(MAX_FLUID_CANVAS_PIXELS / targetPixels) * baseRatio,
  );
  const width = Math.max(2, Math.round(cssWidth * budgetRatio));
  const height = Math.max(2, Math.round(cssHeight * budgetRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
}

function setPaletteUniforms(
  gl: WebGLRenderingContext,
  uniforms: Array<WebGLUniformLocation | null>,
  palette: FluidPalette,
): void {
  palette.forEach((color, index) => {
    const uniform = uniforms[index];
    if (!uniform) return;
    gl.uniform3f(uniform, color[0] / 255, color[1] / 255, color[2] / 255);
  });
}

export function createFluidRenderer(
  canvas: HTMLCanvasElement,
  palette: FluidPalette = DEFAULT_PROMPT_FLUID_PALETTE,
  tone: FluidTone = "light",
  variant: FluidVariant = "bloom",
): FluidRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    desynchronized: true,
    preserveDrawingBuffer: true,
    powerPreference: "low-power",
  });
  const program = gl
    ? createProgram(
        gl,
        variant === "silk" ? SILK_FRAGMENT_SHADER : BLOOM_FRAGMENT_SHADER,
      )
    : null;
  if (!gl || !program) return null;
  const buffer = gl.createBuffer();
  const position = gl.getAttribLocation(program, "a");
  const time = gl.getUniformLocation(program, "u");
  const dark = gl.getUniformLocation(program, "d");
  const resolution = gl.getUniformLocation(program, "r");
  const colors = ["p0", "p1", "p2", "p3", "p4", "p5"].map((name) =>
    gl.getUniformLocation(program, name),
  );
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  setPaletteUniforms(gl, colors, palette);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  return {
    dispose: () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
    draw: (frameTime = performance.now()) => {
      resizeCanvas(canvas, gl);
      gl.useProgram(program);
      gl.uniform1f(time, frameTime);
      gl.uniform1f(dark, tone === "dark" ? 1 : 0);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
  };
}
