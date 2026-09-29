/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { checkWallpaperModule, trimWallpaperShaderLog } from "./check";
import { defineWallpaperModule } from "./manifest";

const saved = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
let lost = false;
let webgl2 = true;
let compiles = 0;

/** An OffscreenCanvas whose WebGL2 context fails to compile sources containing `BROKEN` and to link ones containing `UNLINKED`. */
function installOffscreenGl() {
  const sources = new Map<object, string>();
  const attached = new Map<object, object[]>();
  const gl = new Proxy({
    isContextLost: () => lost,
    createShader: () => ({}),
    shaderSource: (shader: object, source: string) => sources.set(shader, source),
    compileShader: () => { compiles += 1; },
    getShaderParameter: (shader: object) => !sources.get(shader)?.includes("BROKEN"),
    getShaderInfoLog: () => "ERROR: 0:2: 'BROKEN' : undeclared identifier   \n\n\0",
    createProgram: () => ({}),
    attachShader: (program: object, shader: object) => attached.set(program, [...(attached.get(program) ?? []), shader]),
    getProgramParameter: (program: object) => !(attached.get(program) ?? []).some((shader) => sources.get(shader)?.includes("UNLINKED")),
    getProgramInfoLog: () => "ERROR: Linking failed",
    getShaderPrecisionFormat: () => ({ precision: 23 }),
  } as Record<string, unknown>, { get: (target, key) => target[key as string] ?? (() => ({})) });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    writable: true,
    value: class {
      width = 1;
      height = 1;
      getContext(kind: string) {
        return webgl2 && kind === "webgl2" ? gl : null;
      }
    },
  });
}

function flow(fragment: string) {
  return defineWallpaperModule({
    manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
    fragment,
  });
}

beforeEach(() => {
  lost = false;
  webgl2 = true;
  compiles = 0;
  installOffscreenGl();
});

afterEach(() => {
  // Hand the shared context back: the next user creates a real one again.
  lost = true;
  if (saved) Object.defineProperty(globalThis, "OffscreenCanvas", saved);
  else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});

test("a module that compiles and links checks ok, once per source", () => {
  const module = flow("void main(){fragColor=vec4(1.);}");
  expect(checkWallpaperModule(module)).toEqual({ ok: true });
  const compiled = compiles;
  expect(compiled).toBeGreaterThan(0);
  expect(checkWallpaperModule(module)).toEqual({ ok: true });
  expect(compiles).toBe(compiled);
});

test("a compile or link failure returns its stage and the trimmed log", () => {
  expect(checkWallpaperModule(flow("void main(){fragColor=vec4(BROKEN);}"))).toEqual({
    ok: false, stage: "compile", log: "ERROR: 0:2: 'BROKEN' : undeclared identifier",
  });
  expect(checkWallpaperModule(flow("void main(){fragColor=vec4(1.);}// UNLINKED"))).toEqual({
    ok: false, stage: "link", log: "ERROR: Linking failed",
  });
});

test("without WebGL2 there is nothing to check", () => {
  webgl2 = false;
  lost = true;
  expect(checkWallpaperModule(flow("void main(){fragColor=vec4(1.);}"))).toBeNull();
});

test("shader logs lose NULs, blank lines and trailing spaces, and stay short", () => {
  expect(trimWallpaperShaderLog("\0 ERROR: 0:1: a  \n\n  ERROR: 0:2: b\n\0")).toBe("ERROR: 0:1: a\n  ERROR: 0:2: b");
  const long = trimWallpaperShaderLog("x".repeat(10_000));
  expect(long.length).toBeLessThanOrEqual(2000);
  expect(long.endsWith("…")).toBe(true);
});
