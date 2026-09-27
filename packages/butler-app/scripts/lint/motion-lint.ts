import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { compareRatchet, ratchetFailures, shrinkBaseline, type FileCounts } from "./butler-ds/ratchet.ts";
import { UI_SOURCE_ROOT } from "./butler-ds/scope.ts";

/**
 * Motion lint (see the DS spec Motion Contract). Runs over all UI source,
 * design system included, with shrink-only per-file baselines.
 */
export const MOTION_RULES = [
  "motion-outside-ds",
  "keyword-easing",
  "transition-property",
  "waapi-outside-helper",
  "canvas-motion",
] as const;

export type MotionRule = (typeof MOTION_RULES)[number];

export type MotionFinding = { rule: MotionRule; path: string; line: number; message: string };

const DS_PREFIX = "libs/design-system/";
const MOTION_HELPER = "libs/design-system/lib/motion.ts";
/** DS reveal components may transition height/block-size with interpolate-size. */
const REVEAL_COMPONENTS = ["libs/design-system/components/Collapsible/"];

/** Compositor and paint-only properties that may transition or animate. */
const ALLOWED_PROPERTIES = new Set([
  "opacity",
  "transform",
  "translate",
  "scale",
  "rotate",
  "filter",
  "color",
  "background",
  "background-color",
  "border-color",
  "box-shadow",
  "outline-color",
  "visibility",
  // SVG paint: progress rings move their dash offset.
  "stroke-dashoffset",
]);
const DISCRETE_PROPERTIES = new Set(["display", "overlay", "content-visibility"]);
/**
 * Paint-only loops allowed in named DS keyframes: the thinking-label text
 * shimmer moves a background-clip:text gradient on a single short label; the
 * Spinner arc grows and shrinks its SVG dash on one small stroke.
 */
const PAINT_LOOP_KEYFRAMES: Record<string, readonly string[]> = {
  "libs/design-system/blocks/MessageRow/MessageRow.module.css": ["background-position"],
  "libs/design-system/components/Spinner/Spinner.module.css": ["stroke-dasharray"],
};
/** Registered paint-only custom properties (the shared scroll-fade mask). */
const ALLOWED_CUSTOM_PROPERTY = /^--scroll-fade-/u;

const MOTION_PROPERTY = /^(?:transition|animation)(?:-timing-function)?$/u;
const KEYWORD_EASING = /(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w(-])/u;
const NONE_VALUE = /^\s*none\s*$/u;

type Declaration = { prop: string; value: string; line: number; parents: string[] };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

/** Minimal brace-depth walker: declarations with their enclosing preludes. */
function declarations(source: string): { decls: Declaration[]; keyframes: number[] } {
  const css = stripComments(source);
  const decls: Declaration[] = [];
  const keyframes: number[] = [];
  const stack: string[] = [];
  let start = 0;
  const lineAt = (offset: number) => css.slice(0, offset).split("\n").length;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char !== "{" && char !== "}" && char !== ";") continue;
    const text = css.slice(start, index);
    const leading = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (char === "{") {
      if (/^@(?:-\w+-)?keyframes\b/u.test(trimmed)) keyframes.push(lineAt(start + leading));
      stack.push(trimmed);
    } else if (trimmed.includes(":") && !trimmed.startsWith("@")) {
      const colon = trimmed.indexOf(":");
      decls.push({
        prop: trimmed.slice(0, colon).trim().toLowerCase(),
        value: trimmed.slice(colon + 1).trim(),
        line: lineAt(start + leading),
        parents: [...stack],
      });
    }
    if (char === "}") stack.pop();
    start = index + 1;
  }
  return { decls, keyframes };
}

/** Removes var(...), env(...) and linear(...) calls so only raw keywords remain. */
function stripCalls(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const match = /(?:var|env|linear|cubic-bezier|steps)\(/iu.exec(value.slice(index));
    if (!match) return output + value.slice(index);
    output += value.slice(index, index + match.index);
    let depth = 0;
    let cursor = index + match.index + match[0].length - 1;
    for (; cursor < value.length; cursor += 1) {
      if (value[cursor] === "(") depth += 1;
      if (value[cursor] === ")") depth -= 1;
      if (depth === 0) break;
    }
    output += " ";
    index = cursor + 1;
  }
  return output;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The property a transition shorthand item names (first identifier token), or null. */
function transitionItemProperty(item: string): string | null {
  const tokens = stripCalls(item).trim().split(/\s+/u).filter(Boolean);
  const property = tokens.find((token) =>
    !/^-?\d*\.?\d+(?:ms|s)?$/u.test(token) &&
    !KEYWORD_EASING.test(token) &&
    !["allow-discrete", "normal", "infinite"].includes(token));
  return property?.toLowerCase() ?? null;
}

function propertyAllowed(path: string, property: string, declaration: string, source: string): boolean {
  if (ALLOWED_PROPERTIES.has(property)) return true;
  if (ALLOWED_CUSTOM_PROPERTY.test(property)) return true;
  if (DISCRETE_PROPERTIES.has(property)) return /allow-discrete/u.test(declaration) || /transition-behavior\s*:\s*allow-discrete/u.test(source);
  if (property === "height" || property === "block-size") {
    return REVEAL_COMPONENTS.some((prefix) => path.startsWith(prefix)) &&
      /interpolate-size\s*:\s*allow-keywords/u.test(source);
  }
  return false;
}

export function lintMotionCss(path: string, source: string): MotionFinding[] {
  const findings: MotionFinding[] = [];
  const inDs = path.startsWith(DS_PREFIX);
  const { decls, keyframes } = declarations(source);
  if (!inDs) {
    for (const line of keyframes) {
      findings.push({ rule: "motion-outside-ds", path, line, message: "@keyframes belong in design-system components" });
    }
  }
  for (const decl of decls) {
    const inKeyframes = decl.parents.some((parent) => /^@(?:-\w+-)?keyframes\b/u.test(parent));
    if (inKeyframes) {
      const paintLoop = PAINT_LOOP_KEYFRAMES[path]?.includes(decl.prop) ?? false;
      if (!decl.prop.startsWith("--") && !paintLoop && !propertyAllowed(path, decl.prop, decl.value, source)) {
        const rule = decl.prop === "animation-timing-function" ? null : "transition-property";
        if (rule) {
          findings.push({
            rule,
            path,
            line: decl.line,
            message: `keyframes animate "${decl.prop}"; animate only opacity, transform, filter or paint properties`,
          });
        }
      }
      continue;
    }
    const isMotion = /^(?:transition|animation)(?:-[\w-]+)?$/u.test(decl.prop);
    if (!isMotion) continue;
    if (!inDs && !NONE_VALUE.test(decl.value)) {
      findings.push({
        rule: "motion-outside-ds",
        path,
        line: decl.line,
        message: `${decl.prop} belongs in design-system components; compose a DS component instead`,
      });
    }
    if (MOTION_PROPERTY.test(decl.prop) && KEYWORD_EASING.test(stripCalls(decl.value))) {
      findings.push({
        rule: "keyword-easing",
        path,
        line: decl.line,
        message: `${decl.prop} uses a keyword easing; use a var(--motion-ease-*) token`,
      });
    }
    const items = decl.prop === "transition"
      ? splitTopLevel(decl.value).map((item) => ({ item, property: transitionItemProperty(item) }))
      : decl.prop === "transition-property"
        ? splitTopLevel(decl.value).map((item) => ({ item, property: item.toLowerCase() }))
        : [];
    for (const { item, property } of items) {
      if (!property || property === "none") continue;
      if (propertyAllowed(path, property, item, source)) continue;
      findings.push({
        rule: "transition-property",
        path,
        line: decl.line,
        message: `transitions "${property}"; transition only opacity, transform, filter or paint properties`,
      });
    }
  }
  return findings;
}

export function lintMotionScript(path: string, source: string): MotionFinding[] {
  if (path === MOTION_HELPER) return [];
  const findings: MotionFinding[] = [];
  const lines = source.split("\n");
  lines.forEach((text, index) => {
    for (const match of text.matchAll(/\.animate\(|\bstartViewTransition\b/gu)) {
      findings.push({
        rule: "waapi-outside-helper",
        path,
        line: index + 1,
        message: `${match[0].replace("(", "")} must go through animateMotion() in libs/design-system/lib/motion.ts`,
      });
    }
  });
  return findings;
}

/**
 * Canvas animation engines: JS frame loops that draw a simulation, which the
 * CSS/WAAPI token rules cannot see. Every file that draws on a canvas must sit
 * under one of these prefixes, and every timing-named constant in an engine
 * must be listed with the reason it is intrinsic to the simulation. UI timing
 * (fades, transitions, loop cadence) is read from the --motion-* tokens through
 * lib/motion.ts instead.
 */
export interface CanvasMotionEngine {
  prefix: string;
  justification: string;
  /** Timing-named constants allowed as literals, each with its reason. */
  constants: Record<string, string>;
}

export const CANVAS_MOTION_ENGINES: readonly CanvasMotionEngine[] = [
  {
    prefix: "libs/design-system/components/ButlerThinkingMark/",
    justification: "Riso halftone thinking mark: a spring-driven morph and an orbiting-light simulation drawn per frame on a canvas.",
    constants: {
      MORPH_SPRING: "Spring stiffness/damping of the single logo-to-moon morph (k 6, critically damped: ~1.9s to 95%, monotonic, no overshoot); one progress drives every channel, a physical morph, not a UI transition (starts at zero velocity, so no first-frame jump).",
      RISO_MOTION: "Ripple, ink-sweep and light-orbit rates of the simulation clock while working (the look of the mark, not UI timing).",
      FRAME_INTERVAL_MS: "Caps canvas drawing at 60fps on high-refresh displays; a performance budget, not a duration.",
      MAX_STEP_S: "Clamps the simulation step after a stalled frame so the spring stays stable.",
      SPRING_SUBSTEP_S: "Integrator sub-step of the spring solver (numerical stability).",
    },
  },
  {
    prefix: "libs/design-system/blocks/PromptSuggestionList/",
    justification: "Ambient WebGL fluid behind the new-chat prompt suggestions.",
    constants: {
      FRAME_INTERVAL_MS: "Caps the ambient fluid at 20fps to bound GPU/CPU cost; a performance budget, not a duration.",
      FLUID_TIME_PERIOD_SECONDS: "Common period of the shader's time terms, used to wrap the uniform for mediump precision; not a duration.",
    },
  },
];

const CANVAS_CONTEXT = /\.getContext\(/u;
const TIMING_CONSTANT = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*[:=]/u;
const TIMING_NAME = /(?:^|_)(?:MS|S|SEC|SECONDS|DURATION|PERIOD|INTERVAL|DELAY|SPRING|MOTION|RATE|SPEED|FPS|EASE|EASING)(?:_|$)/u;
const EXAMPLE_FILE = /\.(?:showcase|guidance|test)\.tsx?$/u;

/** canvas-motion findings for UI script sources keyed by path relative to the UI root. */
export function lintCanvasEngines(files: Record<string, string>, engines: readonly CanvasMotionEngine[] = CANVAS_MOTION_ENGINES): MotionFinding[] {
  const findings: MotionFinding[] = [];
  const seen = new Map<CanvasMotionEngine, Set<string>>(engines.map((engine) => [engine, new Set()]));
  for (const [path, source] of Object.entries(files)) {
    if (EXAMPLE_FILE.test(path)) continue;
    const engine = engines.find((candidate) => path.startsWith(candidate.prefix));
    const lines = source.split("\n");
    if (!engine) {
      const index = lines.findIndex((text) => CANVAS_CONTEXT.test(text));
      if (index >= 0) {
        findings.push({ rule: "canvas-motion", path, line: index + 1, message: "canvas drawing outside an allowlisted engine; register it in CANVAS_MOTION_ENGINES with a justification" });
      }
      continue;
    }
    lines.forEach((text, index) => {
      const name = TIMING_CONSTANT.exec(text)?.[1];
      if (!name || !TIMING_NAME.test(name)) return;
      seen.get(engine)?.add(name);
      if (name in engine.constants) return;
      findings.push({ rule: "canvas-motion", path, line: index + 1, message: `${name} is a timing constant in a canvas engine; read UI timing from --motion-* tokens (lib/motion.ts) or allowlist it with a reason` });
    });
  }
  for (const [engine, names] of seen) {
    const touched = Object.keys(files).some((path) => path.startsWith(engine.prefix) && !EXAMPLE_FILE.test(path));
    if (!touched) continue;
    for (const name of Object.keys(engine.constants).filter((constant) => !names.has(constant))) {
      findings.push({ rule: "canvas-motion", path: engine.prefix, line: 1, message: `${name} is allowlisted but no longer declared; remove it from CANVAS_MOTION_ENGINES` });
    }
  }
  return findings;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "dist" || entry === "node_modules") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Findings for every UI source file, keyed relative to the UI source root. */
export function collectMotionFindings(repoRoot: string): MotionFinding[] {
  const sourceRoot = join(repoRoot, UI_SOURCE_ROOT);
  const scripts: Record<string, string> = {};
  const findings = walk(sourceRoot).flatMap((absolute) => {
    const path = relative(sourceRoot, absolute).split("\\").join("/");
    if (path.endsWith(".css")) return lintMotionCss(path, readFileSync(absolute, "utf8"));
    if (/\.(?:ts|tsx)$/u.test(path) && !/\.test\.tsx?$/u.test(path) && !path.endsWith(".d.ts")) {
      scripts[path] = readFileSync(absolute, "utf8");
      return lintMotionScript(path, scripts[path]);
    }
    return [];
  });
  return [...findings, ...lintCanvasEngines(scripts)];
}

function countsByRule(findings: MotionFinding[]): Record<MotionRule, FileCounts> {
  const counts = Object.fromEntries(MOTION_RULES.map((rule) => [rule, {}])) as Record<MotionRule, FileCounts>;
  for (const finding of findings) counts[finding.rule][finding.path] = (counts[finding.rule][finding.path] ?? 0) + 1;
  return counts;
}

if (import.meta.main) {
  const root = process.cwd();
  const baselineDir = join(root, "packages", "butler-app", "scripts", "lint", "motion", "baseline");
  const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
    !process.argv.includes("--silent");
  const findings = collectMotionFindings(root);
  const counts = countsByRule(findings);
  const baselinePath = (rule: MotionRule) => join(baselineDir, `${rule}.json`);
  const readBaseline = (rule: MotionRule): FileCounts =>
    existsSync(baselinePath(rule)) ? JSON.parse(readFileSync(baselinePath(rule), "utf8")) as FileCounts : {};

  if (process.argv.includes("--update-baseline")) {
    mkdirSync(baselineDir, { recursive: true });
    const refused: string[] = [];
    for (const rule of MOTION_RULES) {
      const next = shrinkBaseline(readBaseline(rule), counts[rule], { allowGrowth: process.argv.includes("--allow-growth") });
      refused.push(...next.refused.map((entry) => `${rule}: ${entry}`));
      const sorted = Object.fromEntries(Object.entries(next.next).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(baselinePath(rule), `${JSON.stringify(sorted, null, 2)}\n`);
    }
    if (refused.length > 0) {
      console.error("Motion lint baseline only shrinks; fix these increases instead:");
      for (const entry of refused) console.error(`  ${entry}`);
      process.exit(1);
    }
    if (verbose) console.log("Motion lint baseline updated.");
    process.exit(0);
  }

  const failures = MOTION_RULES.flatMap((rule) => ratchetFailures(rule, compareRatchet(readBaseline(rule), counts[rule])))
    .map((failure) => failure.replace("bun run lint:ds:baseline", "bun run lint:motion:baseline"));
  if (failures.length > 0) {
    console.error("Motion lint failed (see the DS spec Motion Contract):");
    for (const failure of failures) console.error(`  ${failure}`);
    const grownFiles = new Set(failures.map((failure) => failure.split(": ")[1]?.split(" ")[0]));
    for (const finding of findings.filter((item) => grownFiles.has(item.path))) {
      console.error(`    ${finding.path}:${finding.line} [${finding.rule}] ${finding.message}`);
    }
    process.exit(1);
  }
  if (verbose) {
    for (const rule of MOTION_RULES) {
      const values = Object.values(counts[rule]);
      console.log(`motion/${rule}: ${values.reduce((sum, value) => sum + value, 0)} baseline violation(s) in ${values.length} file(s)`);
    }
  }
}
