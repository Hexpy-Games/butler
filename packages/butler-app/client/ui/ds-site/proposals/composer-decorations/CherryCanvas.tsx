import { useEffect, useRef } from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "@/butler-ds";
import styles from "./ComposerDecorations.module.css";

/**
 * Proposal-only stand-in for a transparent Wallpaper mode. The DS Wallpaper engine draws an
 * opaque canvas (renderer.ts CONTEXT_ATTRIBUTES alpha: false), so a scene with no background,
 * where the card's own glass shows through, cannot run on it yet. This runtime keeps the
 * engine's contract and policy so the module ports unchanged once the DS adds that mode:
 * - same prelude uniforms (u_resolution, u_pixelRatio, u_time wrapped at timePeriod,
 *   u_noiseTexture 256x256 RGBA REPEAT+LINEAR), fragment writes premultiplied `fragColor`;
 * - at most 20fps, DPR <= 2, nothing drawn while hidden or offscreen, reduced motion holds a
 *   still frame at `stillTime`, context loss stops and restore redraws, unmount frees the GPU.
 */
const FPS = 20;
const PERIOD = 240;
const STILL_TIME = 37;

const PRELUDE = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_time;
uniform sampler2D u_noiseTexture;
uniform float p_lush;
uniform int p_style;
out vec4 fragColor;
`;
const VERTEX = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`;

function noiseBytes(): Uint8Array {
  const bytes = new Uint8Array(256 * 256 * 4);
  let seed = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index += 1) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    bytes[index] = (seed >>> 0) & 255;
  }
  return bytes;
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const linked = gl.createProgram()!;
  gl.attachShader(linked, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(linked, compile(gl.FRAGMENT_SHADER, PRELUDE + fragment));
  gl.linkProgram(linked);
  return gl.getProgramParameter(linked, gl.LINK_STATUS) ? linked : null;
}

export function CherryCanvas({ fragment, lush = true, pixel = false }: { fragment: string; lush?: boolean; pixel?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!canvas || !gl) return undefined;
    let linked: WebGLProgram | null = null;
    let uniforms: Record<string, WebGLUniformLocation | null> = {};
    const setup = () => {
      linked = program(gl, fragment);
      if (!linked) return;
      gl.useProgram(linked);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseBytes());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      uniforms = Object.fromEntries(["u_resolution", "u_pixelRatio", "u_time", "u_noiseTexture", "p_lush", "p_style"].map((name) => [name, gl.getUniformLocation(linked!, name)]));
      gl.uniform1i(uniforms.u_noiseTexture!, 0);
    };
    setup();

    let visible = document.visibilityState !== "hidden";
    let onscreen = true;
    let reduced = prefersReducedMotion();
    let lost = false;
    let frame = 0;
    let last = 0;
    let clock = STILL_TIME * 1000;
    let tickAt: number | null = null;

    const draw = () => {
      if (!linked || lost) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniforms.u_resolution!, width, height);
      gl.uniform1f(uniforms.u_pixelRatio!, ratio);
      gl.uniform1f(uniforms.u_time!, reduced ? STILL_TIME : (clock / 1000) % PERIOD);
      gl.uniform1f(uniforms.p_lush!, lush ? 1 : 0);
      gl.uniform1i(uniforms.p_style!, pixel ? 1 : 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const running = () => visible && onscreen && !reduced && !lost;
    const tick = (now: number) => {
      frame = 0;
      if (!running()) { tickAt = null; return; }
      if (tickAt !== null) clock += Math.min(now - tickAt, 250);
      tickAt = now;
      if (now - last >= 1000 / FPS - 1) { last = now; draw(); }
      frame = requestAnimationFrame(tick);
    };
    const wake = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      tickAt = null;
      if (!visible || !onscreen || lost) return;
      draw();
      if (running()) frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => { visible = document.visibilityState !== "hidden"; wake(); };
    const unsubscribe = subscribeReducedMotion((value) => { reduced = value; wake(); });
    const intersection = new IntersectionObserver((entries) => { onscreen = entries[entries.length - 1]?.isIntersecting ?? true; wake(); });
    intersection.observe(canvas);
    const resize = new ResizeObserver(() => { if (!running()) draw(); });
    resize.observe(canvas);
    const onLost = (event: Event) => { event.preventDefault(); lost = true; wake(); };
    const onRestored = () => { lost = false; setup(); wake(); };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    document.addEventListener("visibilitychange", onVisibility);
    wake();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      intersection.disconnect();
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      document.removeEventListener("visibilitychange", onVisibility);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [fragment, lush, pixel]);
  return <canvas className={styles.cherryCanvas} ref={ref} data-scene-canvas="cherry-blossom" />;
}
