import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const commonDir = join(
  import.meta.dir,
  "../../packages/butler-app/client/ui/src/components/common",
);
const source = readFileSync(join(commonDir, "ButlerThinkingMark.tsx"), "utf8");
const drawing = readFileSync(
  join(commonDir, "thinking-mark/canvas-drawing.ts"),
  "utf8",
);
const statusLabel = readFileSync(
  join(commonDir, "../conversation/AssistantStatusLabel.tsx"),
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
  expect(existsSync(join(commonDir, "thinking-mark/wave-animation.ts"))).toBe(false);
  expect(existsSync(join(commonDir, "thinking-mark/math-utils.ts"))).toBe(false);
});

test("assistant status animates idle and active in place with one mark", () => {
  expect(statusLabel).not.toContain("ButlerMarkIcon");
  expect(statusLabel).toContain('state={state === "active" ? "working" : "idle"}');
});
