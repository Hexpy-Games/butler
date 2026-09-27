import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const uiDir = join(import.meta.dir, "../../packages/butler-app/client/ui/src");
const commonDir = join(uiDir, "components/common");
const markDir = join(uiDir, "libs/design-system/components/ButlerThinkingMark");
const component = readFileSync(join(markDir, "ButlerThinkingMark.tsx"), "utf8");
const source = readFileSync(join(markDir, "markLoop.ts"), "utf8");
const drawing = readFileSync(
  join(markDir, "thinking-mark/canvas-drawing.ts"),
  "utf8",
);
const statusLabel = readFileSync(
  join(uiDir, "components/conversation/AssistantStatusLabel.tsx"),
  "utf8",
);

test("thinking mark keeps layout reads outside its animation frame", () => {
  const renderFrame = source.slice(
    source.indexOf("const render ="),
    source.indexOf("const tick ="),
  );

  expect(source).toContain("const resizeAndRender = () =>");
  expect(renderFrame).not.toContain("resize();");
  expect(renderFrame).not.toContain("getBoundingClientRect");
});

test("thinking mark stops background work without waking sibling marks", () => {
  expect(source).toContain(
    'document.addEventListener("visibilitychange", handleVisibilityChange)',
  );
  expect(source).not.toContain("butler-thinking-mark-state-change");
});

test("thinking mark stops its frame loop once settled", () => {
  const tick = source.slice(source.indexOf("const tick ="), source.indexOf("const startLoop ="));
  expect(tick).toContain("settled()");
  expect(tick).toContain("animationFrame = 0;");
  expect(source).toContain("Math.min(window.devicePixelRatio || 1, 2)");
});

test("thinking mark draws with no per-frame canvas or lattice allocation", () => {
  const perFrame = drawing.slice(drawing.indexOf("export function renderHalftone"));
  expect(perFrame).not.toContain("createElement");
  expect(perFrame).not.toContain("buildHalftone(");
  expect(perFrame).not.toContain("new Float32Array");
});

test("the old wave animation modules are gone", () => {
  expect(existsSync(join(markDir, "thinking-mark/wave-animation.ts"))).toBe(false);
  expect(existsSync(join(markDir, "thinking-mark/math-utils.ts"))).toBe(false);
  expect(existsSync(join(commonDir, "thinking-mark"))).toBe(false);
  expect(existsSync(join(commonDir, "ButlerThinkingMark.tsx"))).toBe(false);
});

test("assistant status animates idle and active in place with one mark", () => {
  expect(statusLabel).not.toContain("ButlerMarkIcon");
  expect(statusLabel).toContain('state={state === "active" ? "working" : "idle"}');
  expect(statusLabel).toContain('from "@/butler-ds"');

});

test("thinking mark pauses offscreen, when hidden and under reduced motion", () => {
  expect(source).toContain("new IntersectionObserver(");
  const tick = source.slice(source.indexOf("const tick ="), source.indexOf("const startLoop ="));
  expect(tick).toContain("if (paused()) return;");
  expect(source).toContain('const paused = () => stopped || !inView || document.visibilityState === "hidden";');
  // Reduced motion never runs the frame loop: the still logo is drawn once.
  expect(source).toContain("const settled = () => inputs.isReduced() || (!inputs.isWorking() && sim.idle);");
  expect(component).toContain("subscribeReducedMotion(");
  expect(component).toContain("useState(prefersReducedMotion)");
});

test("reduced motion breathes in CSS on the Spinner's pulse cadence and settles on motion tokens", () => {
  const css = readFileSync(join(markDir, "ButlerThinkingMark.module.css"), "utf8").replace(/\s+/gu, " ");
  expect(css).toContain('.canvas[data-breathe="on"] { animation: thinking-mark-breathe calc(var(--pulse-duration) * 2) var(--spinner-easing) infinite alternate; }');
  expect(css).toContain('.canvas[data-breathe="settle"] { animation: thinking-mark-settle var(--motion-slow) var(--motion-ease-standard); }');
  expect(css).toMatch(/@keyframes thinking-mark-breathe \{ to \{ opacity: 0\.45; \} \}/u);
  expect(source).not.toMatch(/1000 \/ 60/u);
  expect(component).not.toContain("requestAnimationFrame");
});
