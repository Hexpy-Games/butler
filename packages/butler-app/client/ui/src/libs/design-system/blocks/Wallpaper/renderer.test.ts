/// <reference types="bun" />
import { expect, test } from "bun:test";
import { wallpaperImageUniforms } from "./imageMath";
import { defineWallpaperModule } from "./manifest";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry, resolveWallpaperScene } from "./registry";
import { createWallpaperRenderer } from "./renderer";
import { WALLPAPER_TIME_PERIOD_SECONDS, wallpaperShaderTime } from "./time";
import type { WallpaperError, WallpaperSource } from "./types";

type Call = [string, ...unknown[]];

function fakeCanvas({ failSource }: { failSource?: string } = {}) {
  const calls: Call[] = [];
  const sources = new Map<object, string>();
  const gl: Record<string, unknown> = {
    createShader: () => ({}),
    shaderSource: (shader: object, source: string) => sources.set(shader, source),
    getShaderParameter: (shader: object) => !(failSource && sources.get(shader)?.includes(failSource)),
    getShaderInfoLog: () => "ERROR: 0:3: syntax error",
    createProgram: () => { calls.push(["createProgram"]); return {}; },
    getProgramParameter: () => true,
    getUniformLocation: (_program: unknown, name: string) => name,
    getShaderPrecisionFormat: () => ({ precision: 23 }),
    uniform1f: (location: string, value: number) => calls.push(["uniform1f", location, value]),
    uniform1i: (location: string, value: number) => calls.push(["uniform1i", location, value]),
    uniform3fv: (location: string, value: Float32Array) => calls.push(["uniform3fv", location, [...value]]),
    uniform3f: (location: string, ...value: number[]) => calls.push(["uniform3f", location, value]),
    uniform4f: (location: string, ...value: number[]) => calls.push(["uniform4f", location, value]),
    drawArrays: (...args: unknown[]) => calls.push(["drawArrays", ...args]),
    viewport: (...args: unknown[]) => calls.push(["viewport", ...args]),
  };
  for (const name of ["deleteProgram", "texImage2D", "texParameteri", "generateMipmap", "deleteTexture", "bindFramebuffer", "enable", "disable", "blendFuncSeparate", "clearColor", "clear"]) {
    gl[name] = (...args: unknown[]) => calls.push([name, ...args]);
  }
  // GL enums read as their names so calls stay legible.
  const context = new Proxy(gl, { get: (target, key) => target[key as string] ?? (/^[A-Z0-9_]+$/u.test(String(key)) ? key : () => ({})) });
  const attributes: Array<WebGLContextAttributes | undefined> = [];
  const getContext = (kind: string, options?: WebGLContextAttributes) => (attributes.push(options), kind === "webgl2" ? context : null);
  const canvas = { dataset: {}, width: 0, height: 0, getContext } as unknown as HTMLCanvasElement;
  return { calls, canvas, attributes };
}

function sceneOf(source: WallpaperSource, tone: "light" | "dark" = "light") {
  return resolveWallpaperScene(source, BUILTIN_WALLPAPERS, tone)!;
}

const FRAME = { width: 320, height: 200, pixelRatio: 1, timeMs: 86_400_000 * 3 + 1234, dayPhase: 0.5, seed: 0.25 };

function uniform(calls: Call[], name: string) {
  return calls.filter((call) => call[1] === name).at(-1)?.[2];
}

test("no WebGL2 means no renderer", () => {
  const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
  expect(createWallpaperRenderer(canvas, { onError: () => undefined })).toBeNull();
});

test("programs compile once per module source; param and tone changes only touch uniforms", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  renderer.setScene(sceneOf({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } }));
  renderer.setScene(sceneOf({ kind: "live", module: "butler.bloom", params: { colors: ["#000000", "#000000", "#000000", "#000000", "#000000", "#ffffff"] } }, "dark"));
  expect(calls.filter(([name]) => name === "createProgram")).toHaveLength(1);
  renderer.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  renderer.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  expect(calls.filter(([name]) => name === "createProgram")).toHaveLength(2);
});

test("draw uploads the wrapped time, tone, engine uniforms and params", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setScene(sceneOf({ kind: "live", module: "butler.bloom", params: { colors: "morning" } }, "dark"));
  renderer.draw(FRAME);
  const time = uniform(calls, "u_time") as number;
  expect(time).toBeCloseTo(wallpaperShaderTime(FRAME.timeMs, "animated"), 6);
  expect(time).toBeLessThan(WALLPAPER_TIME_PERIOD_SECONDS);
  expect(uniform(calls, "u_dark")).toBe(1);
  expect(uniform(calls, "u_dayPhase")).toBe(0.5);
  expect(uniform(calls, "u_seed")).toBe(0.25);
  expect(uniform(calls, "u_pixelRatio")).toBe(1);
  expect(uniform(calls, "u_hasImage")).toBe(0);
  expect(uniform(calls, "u_noiseTexture")).toBe(0);
  expect(uniform(calls, "u_image")).toBe(1);
  expect((uniform(calls, "p_colors") as number[]).slice(0, 3)).toEqual([125 / 255, 211 / 255, 252 / 255]);
  expect(canvas.width).toBe(320);
  expect(canvas.height).toBe(200);
  expect(calls.some(([name]) => name === "drawArrays")).toBe(true);
});

test("time wraps by the module's timePeriod; the content rect is uploaded (zeros when unknown)", () => {
  const hourly = defineWallpaperModule({
    manifest: { id: "me.hourly", name: { en: "Hourly", ko: "매시" }, version: "0.1.0", engine: 1, motion: "animated", image: "none", timePeriod: 3600, params: [] },
    fragment: "void main(){fragColor=vec4(fract(u_time/3600.),u_contentRect.xy,1.);}",
  });
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setScene({ key: "hourly", module: hourly, values: {}, dark: false, image: null, error: null });
  expect(renderer.usesContentRect()).toBe(true);
  renderer.draw({ ...FRAME, timeMs: (3600 * 5 + 37) * 1000, contentRect: [20, 50, 80, 40] });
  expect(uniform(calls, "u_time") as number).toBeCloseTo(37, 3);
  expect(uniform(calls, "u_contentRect")).toEqual([20, 50, 80, 40]);
  renderer.draw(FRAME);
  expect(uniform(calls, "u_contentRect")).toEqual([0, 0, 0, 0]);
});

test("a module that fails to compile falls back to the default module and reports it", () => {
  const broken = defineWallpaperModule({
    manifest: { id: "me.broken", name: { en: "Broken", ko: "깨짐" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
    fragment: "void main(){fragColor=vec4(BROKEN);}",
  });
  const { calls, canvas } = fakeCanvas({ failSource: "BROKEN" });
  const errors: WallpaperError[] = [];
  const renderer = createWallpaperRenderer(canvas, { onError: (error) => errors.push(error) })!;
  renderer.setScene({ key: "broken", module: broken, values: {}, dark: false, image: null, error: null });
  expect(errors).toEqual([{ reason: "compile", module: "me.broken", message: "ERROR: 0:3: syntax error" }]);
  expect(renderer.motion()).toBe("animated");
  expect(renderer.drawnModule()).toBe("butler.bloom");
  renderer.draw(FRAME);
  expect(uniform(calls, "p_colors")).toBeDefined();
  // The failure is cached: re-rendering the same scene does not recompile or re-report.
  renderer.setScene({ key: "broken", module: broken, values: {}, dark: false, image: null, error: null });
  expect(errors).toHaveLength(1);
});

test("opaque canvases keep alpha off; a transparent one is premultiplied, cleared to 0 each frame and empty when its module fails", () => {
  const opaque = fakeCanvas();
  createWallpaperRenderer(opaque.canvas, { onError: () => undefined })!.setScene(sceneOf({ kind: "live", module: "butler.bloom" }));
  expect(opaque.attributes[0]).toMatchObject({ alpha: false });
  expect(opaque.attributes[0]).not.toHaveProperty("premultipliedAlpha");

  const broken = defineWallpaperModule({
    manifest: { id: "me.petal", name: { en: "Petal", ko: "꽃잎" }, version: "0.1.0", engine: 1, motion: "animated", image: "none", transparent: true, params: [] },
    fragment: "void main(){fragColor=vec4(BROKEN);}",
  });
  const { calls, canvas, attributes } = fakeCanvas({ failSource: "BROKEN" });
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined, transparent: true })!;
  expect(attributes[0]).toMatchObject({ alpha: true, premultipliedAlpha: true });
  renderer.setScene(sceneOf({ kind: "live", module: "butler.cherry-blossom" }));
  renderer.draw(FRAME);
  expect(calls.filter(([name]) => name === "clearColor" || name === "clear" || name === "drawArrays").map(([name]) => name))
    .toEqual(["clearColor", "clear", "drawArrays"]);
  expect(calls.find(([name]) => name === "clearColor")?.slice(1)).toEqual([0, 0, 0, 0]);
  calls.length = 0;
  renderer.setScene({ key: "petal", module: broken, values: {}, dark: false, image: null, error: null });
  expect(renderer.drawnModule()).toBeNull();
  renderer.draw(FRAME);
  expect(calls.some(([name]) => name === "clear")).toBe(true);
  expect(calls.some(([name]) => name === "drawArrays")).toBe(false);
});

test("a new shader for a module replaces its program; the old one is deleted", () => {
  const flow = (fragment: string) => defineWallpaperModule({
    manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
    fragment,
  });
  const sceneWith = (module: ReturnType<typeof flow>) =>
    resolveWallpaperScene({ kind: "live", module: "me.flow" }, createWallpaperRegistry([module]), "light")!;
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  const first = flow("void main(){fragColor=vec4(1.);}");
  renderer.setScene(sceneWith(first));
  expect(renderer.drawnModule()).toBe("me.flow");
  renderer.setScene(sceneWith(flow("void main(){fragColor=vec4(.5);}")));
  expect(named(calls, "createProgram")).toHaveLength(2);
  expect(named(calls, "deleteProgram")).toHaveLength(1);
  // Going back compiles again: only the latest source of a module is kept.
  renderer.setScene(sceneWith(first));
  expect(named(calls, "createProgram")).toHaveLength(3);
});

test("restore after a lost context rebuilds programs", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setScene(sceneOf({ kind: "live", module: "butler.silk" }));
  renderer.restore();
  renderer.draw(FRAME);
  expect(calls.filter(([name]) => name === "createProgram")).toHaveLength(2);
  expect(uniform(calls, "p_base")).toEqual([1, 1, 1]);
});

const IMAGE = { kind: "image", asset: "a", fit: "cover", dim: 0, blur: 0 } as const;
const BITMAP = { width: 2000, height: 1000, close: () => undefined } as unknown as ImageBitmap;

function named(calls: Call[], name: string) {
  return calls.filter((call) => call[0] === name);
}

test("an image scene without its image draws the neutral field of the static image module", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setScene(sceneOf(IMAGE));
  expect(renderer.motion()).toBe("static");
  renderer.draw(FRAME);
  expect(uniform(calls, "u_hasImage")).toBe(0);
  expect(named(calls, "drawArrays")).toHaveLength(1);
});

test("an uploaded image is a mipmapped, clamped texture drawn with its aspect, fit and blur", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setImage("a", "full", BITMAP);
  expect(renderer.imageVariant("a")).toBe("full");
  expect(named(calls, "texImage2D").at(-1)).toEqual(["texImage2D", "TEXTURE_2D", 0, "RGBA8", "RGBA", "UNSIGNED_BYTE", BITMAP]);
  expect(named(calls, "generateMipmap")).toEqual([["generateMipmap", "TEXTURE_2D"]]);
  expect(named(calls, "texParameteri").slice(-4)).toEqual([
    ["texParameteri", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "LINEAR_MIPMAP_LINEAR"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_MAG_FILTER", "LINEAR"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_WRAP_S", "CLAMP_TO_EDGE"],
    ["texParameteri", "TEXTURE_2D", "TEXTURE_WRAP_T", "CLAMP_TO_EDGE"],
  ]);
  renderer.setScene(sceneOf({ ...IMAGE, fit: "contain", blur: 0.5 }));
  renderer.draw(FRAME);
  const expected = wallpaperImageUniforms({ fit: "contain", blur: 0.5 }, BITMAP, FRAME);
  expect(uniform(calls, "u_hasImage")).toBe(1);
  expect(uniform(calls, "u_imageAspectRatio")).toBe(2);
  expect(uniform(calls, "image_fit")).toEqual([...expected.fit]);
  expect(uniform(calls, "image_blur")).toEqual([...expected.blur]);
  // No dim: nothing is blended over the image.
  expect(named(calls, "blendFuncSeparate")).toHaveLength(0);
});

test("dim multiplies the frame after the module; the dark theme dims one step more", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setImage("a", "full", BITMAP);
  renderer.setScene(sceneOf({ ...IMAGE, dim: 0.25 }, "dark"));
  renderer.draw(FRAME);
  expect(uniform(calls, "u_brightness") as number).toBeCloseTo(0.6, 6);
  expect(named(calls, "blendFuncSeparate")).toEqual([["blendFuncSeparate", "ZERO", "SRC_ALPHA", "ZERO", "ONE"]]);
  expect(named(calls, "drawArrays")).toHaveLength(2);
  expect(named(calls, "disable").at(-1)).toEqual(["disable", "BLEND"]);
});

const DUOTONE = defineWallpaperModule({
  manifest: {
    id: "me.duotone", name: { en: "Duotone", ko: "듀오톤" }, version: "0.1.0", engine: 1, motion: "animated", image: "required",
    params: [{ key: "ink", label: { en: "Ink", ko: "잉크" }, type: "color", default: "#ff0000" }],
  },
  fragment: "void main(){fragColor=vec4(p_ink*texture(u_image,gl_FragCoord.xy/u_resolution).r,1.);}",
});
const FILTERS = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), DUOTONE]);

test("a filter draws over the image pre-fitted to the canvas, which re-renders only on change", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setImage("a", "full", BITMAP);
  renderer.setScene(resolveWallpaperScene({ ...IMAGE, blur: 0.2, filter: { module: "me.duotone" } }, FILTERS, "light")!);
  expect(renderer.motion()).toBe("animated");
  renderer.draw(FRAME);
  // Pre-fit pass into a framebuffer, then the filter on screen.
  expect(named(calls, "bindFramebuffer").map((call) => call[2] === null)).toEqual([false, true]);
  expect(named(calls, "drawArrays")).toHaveLength(2);
  expect(uniform(calls, "u_imageAspectRatio")).toBe(FRAME.width / FRAME.height);
  expect(uniform(calls, "p_ink")).toEqual([1, 0, 0]);
  renderer.draw({ ...FRAME, timeMs: FRAME.timeMs + 50 });
  expect(named(calls, "drawArrays")).toHaveLength(3);
  renderer.draw({ ...FRAME, width: 640 });
  expect(named(calls, "drawArrays")).toHaveLength(5);
});

test("a filter that fails to compile falls back to the plain image and reports it", () => {
  const broken = defineWallpaperModule({
    manifest: { ...DUOTONE.manifest, id: "me.broken" },
    fragment: "void main(){fragColor=vec4(BROKEN);}",
  });
  const { calls, canvas } = fakeCanvas({ failSource: "BROKEN" });
  const errors: WallpaperError[] = [];
  const renderer = createWallpaperRenderer(canvas, { onError: (error) => errors.push(error) })!;
  renderer.setImage("a", "full", BITMAP);
  const registry = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), broken]);
  renderer.setScene(resolveWallpaperScene({ ...IMAGE, filter: { module: "me.broken" } }, registry, "light")!);
  expect(errors.map((error) => error.module)).toEqual(["me.broken"]);
  expect(renderer.motion()).toBe("static");
  renderer.draw(FRAME);
  expect(uniform(calls, "u_hasImage")).toBe(1);
  expect(uniform(calls, "image_fit")).toBeDefined();
  expect(named(calls, "bindFramebuffer")).toHaveLength(0);
});

test("unused textures are deleted; a restored context forgets every texture", () => {
  const { calls, canvas } = fakeCanvas();
  const renderer = createWallpaperRenderer(canvas, { onError: () => undefined })!;
  renderer.setImage("a", "thumbnail", BITMAP);
  renderer.setImage("b", "full", BITMAP);
  renderer.retainImages(new Set(["b"]));
  expect(named(calls, "deleteTexture")).toHaveLength(1);
  expect(renderer.imageVariant("a")).toBeNull();
  expect(renderer.imageVariant("b")).toBe("full");
  renderer.restore();
  expect(renderer.imageVariant("b")).toBeNull();
});

test("dispose frees the GPU objects, then gives the context back", () => {
  const { calls, canvas } = fakeCanvas();
  const lost: string[] = [];
  const context = canvas.getContext("webgl2") as unknown as Record<string, unknown>;
  const getExtension = (name: string) => (name === "WEBGL_lose_context" ? { loseContext: () => lost.push("lost") } : null);
  const withExtension = new Proxy(context, { get: (target, key) => (key === "getExtension" ? getExtension : target[key as string]) });
  const owned = { ...canvas, getContext: () => withExtension } as unknown as HTMLCanvasElement;
  const renderer = createWallpaperRenderer(owned, { onError: () => undefined })!;
  renderer.setImage("a", "full", BITMAP);
  renderer.dispose();
  expect(named(calls, "deleteTexture").length).toBeGreaterThan(0);
  expect(lost).toEqual(["lost"]);
});
