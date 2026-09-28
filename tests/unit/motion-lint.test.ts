import { describe, expect, test } from "bun:test";
import {
  CANVAS_MOTION_ENGINES,
  MOTION_RULES,
  lintCanvasEngines,
  lintMotionCss,
  lintMotionScript,
  type MotionFinding,
} from "../../packages/butler-app/scripts/lint/motion-lint.ts";

const DS = "libs/design-system/components/Example/Example.module.css";
const PRODUCT = "components/example/Example.module.css";

function rules(findings: MotionFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

describe("motion lint rules", () => {
  test("exposes the five ratcheted motion rules", () => {
    expect([...MOTION_RULES]).toEqual([
      "motion-outside-ds",
      "keyword-easing",
      "transition-property",
      "waapi-outside-helper",
      "canvas-motion",
    ]);
  });

  test("motion-outside-ds rejects transitions, animations and keyframes in product CSS", () => {
    const css = `
      .a { transition: opacity var(--motion-fast) var(--motion-ease-standard); }
      .b { animation: fade var(--motion-fast) var(--motion-ease-decelerate); }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    `;
    expect(rules(lintMotionCss(PRODUCT, css)).filter((rule) => rule === "motion-outside-ds")).toHaveLength(3);
    expect(rules(lintMotionCss(DS, css))).not.toContain("motion-outside-ds");
    expect(rules(lintMotionCss(PRODUCT, ".a { transition: none; animation: none; }"))).toEqual([]);
  });

  test("keyword-easing rejects keyword easings but accepts tokens and linear() curves", () => {
    for (const easing of ["ease", "ease-in", "ease-out", "ease-in-out", "linear"]) {
      expect(rules(lintMotionCss(DS, `.a { transition: opacity var(--motion-fast) ${easing}; }`)))
        .toEqual(["keyword-easing"]);
    }
    expect(rules(lintMotionCss(DS, ".a { animation: spin var(--spinner-duration) linear infinite; }")))
      .toEqual(["keyword-easing"]);
    expect(lintMotionCss(DS, ".a { transition: opacity var(--motion-fast) var(--motion-ease-standard); }")).toEqual([]);
    expect(lintMotionCss(DS, ".a { animation: spin var(--spinner-duration) var(--motion-ease-linear) infinite; }"))
      .toEqual([]);
    expect(lintMotionCss(DS, ".a { animation-timing-function: linear(0, 0.5, 1); }")).toEqual([]);
    expect(lintMotionCss("libs/design-system/tokens.css", ":root { --motion-ease-linear: linear; }")).toEqual([]);
  });

  test("transition-property allows compositor and paint properties only", () => {
    const allowed = [
      "opacity", "transform", "translate", "scale", "rotate", "filter", "color", "background-color",
      "border-color", "box-shadow", "outline-color", "visibility",
    ];
    for (const property of allowed) {
      expect(lintMotionCss(DS, `.a { transition: ${property} var(--motion-fast) var(--motion-ease-standard); }`))
        .toEqual([]);
    }
    for (const property of ["width", "left", "top", "margin", "grid-template-columns", "grid-template-rows", "min-height", "all"]) {
      expect(rules(lintMotionCss(DS, `.a { transition: ${property} var(--motion-fast) var(--motion-ease-standard); }`)))
        .toEqual(["transition-property"]);
    }
    expect(rules(lintMotionCss(DS, ".a { transition-property: opacity, width; }"))).toEqual(["transition-property"]);
    expect(rules(lintMotionCss(DS, `.a {
      transition:
        opacity var(--motion-fast) var(--motion-ease-standard),
        left var(--motion-slow) var(--motion-ease-emphasized);
    }`))).toEqual(["transition-property"]);
  });

  test("discrete display/overlay transitions need allow-discrete", () => {
    expect(lintMotionCss(DS, ".a { transition: display var(--motion-fast) allow-discrete; }")).toEqual([]);
    expect(rules(lintMotionCss(DS, ".a { transition: display var(--motion-fast); }"))).toEqual(["transition-property"]);
  });

  test("height reveals are allowed only in DS reveal components with interpolate-size", () => {
    const reveal = "libs/design-system/components/Collapsible/Collapsible.module.css";
    const css = ".a { interpolate-size: allow-keywords; transition: height var(--motion-base) var(--motion-ease-standard); }";
    expect(lintMotionCss(reveal, css)).toEqual([]);
    expect(rules(lintMotionCss(DS, css))).toEqual(["transition-property"]);
    expect(rules(lintMotionCss(reveal, ".a { transition: block-size var(--motion-base) var(--motion-ease-standard); }")))
      .toEqual(["transition-property"]);
    expect(lintMotionCss(reveal, ".a { interpolate-size: allow-keywords; transition: block-size var(--motion-base) var(--motion-ease-standard); }"))
      .toEqual([]);
  });

  test("keyframes may only animate allowlisted properties", () => {
    expect(lintMotionCss(DS, "@keyframes a { from { opacity: 0; transform: scale(0.97); } }")).toEqual([]);
    expect(rules(lintMotionCss(DS, "@keyframes a { from { width: 0; } to { width: 10px; } }")))
      .toEqual(["transition-property", "transition-property"]);
  });

  test("only the named text shimmer may loop background-position", () => {
    const shimmer = "@keyframes s { from { background-position: 100% 0; } to { background-position: 0% 0; } }";
    expect(lintMotionCss("libs/design-system/blocks/MessageRow/MessageRow.module.css", shimmer)).toEqual([]);
    expect(rules(lintMotionCss(DS, shimmer))).toEqual(["transition-property", "transition-property"]);
  });

  test("waapi-outside-helper rejects element.animate and startViewTransition outside the helper", () => {
    const code = "element.animate([{ opacity: 0 }], 120); document.startViewTransition(() => {});";
    expect(rules(lintMotionScript("components/settings/ModelRouteFrame.tsx", code)))
      .toEqual(["waapi-outside-helper", "waapi-outside-helper"]);
    expect(lintMotionScript("libs/design-system/lib/motion.ts", code)).toEqual([]);
    expect(lintMotionScript("components/x.tsx", "animateMotion(element, 'enter');")).toEqual([]);
  });

  test("canvas-motion requires canvas drawing to live in an allowlisted engine", () => {
    const files = { "libs/design-system/components/Glow/Glow.tsx": "const ctx = canvas.getContext(\"2d\");" };
    expect(rules(lintCanvasEngines(files, []))).toEqual(["canvas-motion"]);
    const engine = { prefix: "libs/design-system/components/Glow/", justification: "test", constants: {} };
    expect(lintCanvasEngines(files, [engine])).toEqual([]);
    // Showcases may draw canvases for demos.
    expect(lintCanvasEngines({ "libs/design-system/components/Glow/Glow.showcase.tsx": "canvas.getContext(\"2d\")" }, [])).toEqual([]);
  });

  test("canvas-motion requires timing constants in an engine to be allowlisted with a reason", () => {
    const engine = { prefix: "libs/design-system/components/Glow/", justification: "test", constants: { GLOW_SPRING: "physics" } };
    const code = [
      "export const GLOW_SPRING = { k: 9 };",
      "export const FADE_MS = 220;",
      "const PULSE_PERIOD = 3.4;",
      "export const TAU = Math.PI * 2;",
      "export const RING_R = 435;",
    ].join("\n");
    const findings = lintCanvasEngines({ "libs/design-system/components/Glow/constants.ts": code }, [engine]);
    expect(findings.map((finding) => finding.message.split(" ")[0])).toEqual(["FADE_MS", "PULSE_PERIOD"]);
    expect(findings.map((finding) => finding.line)).toEqual([2, 3]);
  });

  test("canvas-motion flags allowlisted constants that no longer exist", () => {
    const engine = { prefix: "libs/design-system/components/Glow/", justification: "test", constants: { GONE_MS: "stale" } };
    expect(rules(lintCanvasEngines({ "libs/design-system/components/Glow/Glow.tsx": "canvas.getContext(\"2d\")" }, [engine])))
      .toEqual(["canvas-motion"]);
  });

  test("the thinking-mark engine allowlists only its simulation constants, each with a reason", () => {
    const mark = CANVAS_MOTION_ENGINES.find((engine) => engine.prefix.endsWith("ButlerThinkingMark/"));
    expect(mark).toBeDefined();
    expect(Object.keys(mark!.constants).sort()).toEqual(["FRAME_INTERVAL_MS", "MAX_STEP_S", "MORPH_SPRING", "RISO_MOTION", "SPRING_SUBSTEP_S"]);
    for (const reason of Object.values(mark!.constants)) expect(reason.length).toBeGreaterThan(20);
  });

  test("the wallpaper engine is the only WebGL wallpaper path and justifies each policy constant", () => {
    const wallpaper = CANVAS_MOTION_ENGINES.find((engine) => engine.prefix === "libs/design-system/blocks/Wallpaper/");
    expect(wallpaper).toBeDefined();
    expect(CANVAS_MOTION_ENGINES.some((engine) => engine.prefix.includes("PromptSuggestionList"))).toBe(false);
    expect(Object.keys(wallpaper!.constants).sort()).toEqual([
      "SECONDS_PER_DAY", "WALLPAPER_ANIMATED_FPS", "WALLPAPER_DAY_PHASE_REFRESH_MS", "WALLPAPER_MAX_CLOCK_STEP_MS",
      "WALLPAPER_SCENE_TONE_CHECK_MS", "WALLPAPER_TIME_PERIOD_SECONDS", "WALLPAPER_WATCHDOG_RETRY_MAX_MS",
      "WALLPAPER_WATCHDOG_RETRY_MS", "WALLPAPER_WATCHDOG_SLOW_RENDER_MS",
    ]);
    for (const reason of Object.values(wallpaper!.constants)) expect(reason.length).toBeGreaterThan(20);
  });
});
