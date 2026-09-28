#!/usr/bin/env bun
/**
 * Token-only style lint for the site, adapted from the app's design-token lint
 * (packages/butler-app/scripts/lint/design-token-lint.ts):
 * - raw-color: no hex/rgb/hsl or white/black keywords outside tokens.css
 * - raw-font: no raw font-size/font-family/font-weight/font outside tokens.css
 * - raw-hex-token: tokens.css keeps raw hex in source palette tokens only
 * - unknown-token: var(--x) without a fallback must be a token or a local property
 * - inline-style: no inline color or typography styles in markup
 * - ds-prop: components take no className/class/style (strong-constraint DS)
 * - circled-number: no circled numerals (U+2460-24FF, U+2776-2793); lists show "1."
 * - custom-counter: ordered lists keep native "1." markers, no counter() badges
 * - list-spacing: ul and ol share every margin/padding rule (only markers
 *   differ), and list margin resets have zero specificity so they never
 *   outrank the flow spacing between blocks
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FORK_TOKENS_PATH, SITE_ROOT, parseTokenScopes } from "./check-token-sync";

export interface Finding {
  path: string;
  line: number;
  rule:
    | "raw-color"
    | "raw-font"
    | "raw-hex-token"
    | "unknown-token"
    | "inline-style"
    | "ds-prop"
    | "circled-number"
    | "custom-counter"
    | "list-spacing";
  text: string;
}

export interface CssLintOptions {
  knownTokens: Set<string>;
  isTokens?: boolean;
}

const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(^|[^\w-])(white|black)(?![\w-])/iu;
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/u;
const RAW_FONT =
  /(?<![\w-])(?:font-size\s*:\s*(?!\s*(?:var\(|inherit|unset|initial|revert))|font-family\s*:\s*(?!\s*(?:var\(|inherit|unset|initial|revert))|font-weight\s*:\s*(?!\s*(?:var\(|inherit|unset|initial|revert))|font\s*:\s*(?!\s*(?:var\(|inherit|unset|initial|revert)))/iu;
const PALETTE_TOKEN = /^--(?:neutral|grayscale|blue|green|red|amber|orange|web-palette)-/u;
const JSX_INLINE_STYLE =
  /style\s*=\s*\{\{[^}]*(?<![\w-])(?:color|background(?:Color)?|borderColor|fontSize|fontFamily|fontWeight|font)\s*:/u;
const HTML_INLINE_STYLE =
  /style\s*=\s*"[^"]*(?<![\w-])(?:color|background(?:-color)?|border-color|font-size|font-family|font-weight|font)\s*:/u;
const COMPONENT_TAG = /<([A-Z][\w.]*)\b([^<>]*?)\/?>/gsu;
const STYLE_ATTRIBUTE = /\s(className|class(?::list)?|style)\s*=/u;
/** A props declaration (type position), not an object literal assigning a class. */
const CIRCLED_NUMBER = /[\u2460-\u24FF\u2776-\u2793]/u;
const CUSTOM_COUNTER = /content\s*:[^;]*\bcounters?\(/u;
const LIST_TAG = /(?<![\w.#-])(ul|ol)(?![\w-])/gu;
const SPACING_PROPERTY = /^(?:margin|padding)(?:-[a-z-]+)?$/u;
const TOP_MARGIN_PROPERTY = /^margin(?:-top|-block|-block-start)?$/u;
const ZERO_FIRST_VALUE = /^0(?:px)?(?:\s|$)/u;

function lintCircledNumbers(path: string, source: string, lineOffset = 0): Finding[] {
  return source.split("\n").flatMap((line, index) =>
    CIRCLED_NUMBER.test(line)
      ? [{ path, line: index + lineOffset + 1, rule: "circled-number" as const, text: line.trim() }]
      : []);
}

/** Top-level comma-separated selectors of a rule prelude. */
function splitSelectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(prelude.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(prelude.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** True when nothing outside :where() adds specificity. */
function hasZeroSpecificity(selector: string): boolean {
  let rest = "";
  for (let index = 0; index < selector.length; ) {
    if (!selector.startsWith(":where(", index)) {
      rest += selector[index];
      index += 1;
      continue;
    }
    let depth = 0;
    let end = index + ":where".length;
    for (; end < selector.length; end += 1) {
      if (selector[end] === "(") depth += 1;
      else if (selector[end] === ")" && --depth === 0) break;
    }
    index = end + 1;
  }
  return /^[\s>+~*]*$/u.test(rest);
}

/**
 * ul and ol are the same kind of block: a rule that spaces one spaces the
 * other, and a list margin reset must lose to every spacing rule (the flow
 * between blocks included), whatever the stylesheet order.
 */
function lintListSpacing(clean: string): Array<{ line: number; text: string }> {
  const findings: Array<{ line: number; text: string }> = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const prelude = match[1].trim();
    const tags = [...prelude.matchAll(LIST_TAG)].map((tag) => tag[1]);
    if (prelude.startsWith("@") || tags.length === 0) continue;
    const declarations = [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+)/gu)].map(([, name, value]) => [name.toLowerCase(), value.trim()]);
    const problems: string[] = [];
    const count = (tag: string) => tags.filter((name) => name === tag).length;
    if (declarations.some(([name]) => SPACING_PROPERTY.test(name)) && count("ul") !== count("ol")) {
      problems.push("ul and ol must share spacing rules");
    }
    const resetsTop = declarations.some(([name, value]) => TOP_MARGIN_PROPERTY.test(name) && ZERO_FIRST_VALUE.test(value));
    const outranks = splitSelectors(prelude).some((selector) => (selector.match(LIST_TAG)?.length ?? 0) > 0 && !hasZeroSpecificity(selector));
    if (resetsTop && outranks) problems.push("list margin resets need zero specificity (wrap the selector in :where())");
    if (problems.length > 0) {
      const start = match.index + match[1].indexOf(prelude);
      findings.push({ line: clean.slice(0, start).split("\n").length - 1, text: `${prelude.replace(/\s+/gu, " ")}: ${problems.join("; ")}` });
    }
  }
  return findings;
}

const DS_STYLE_PROP = /^\s*(?:className|style)\??\s*:\s*(?:string|CSSProperties|React\.CSSProperties)\b/u;

function stripComments(source: string): string {
  // Keep newlines so line numbers survive.
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function localProperties(source: string): Set<string> {
  return new Set([...source.matchAll(/(--[\w-]+)\s*:/gu)].map((match) => match[1]));
}

export function lintCss(path: string, source: string, options: CssLintOptions, lineOffset = 0): Finding[] {
  const findings: Finding[] = lintCircledNumbers(path, source, lineOffset);
  const clean = stripComments(source);
  const local = localProperties(clean);
  const push = (line: number, rule: Finding["rule"], text: string) =>
    findings.push({ path, line: line + lineOffset + 1, rule, text: text.trim() });
  // The custom property whose (possibly multi-line) value is being read.
  let openDefinition: string | null = null;
  clean.split("\n").forEach((line, index) => {
    if (options.isTokens) {
      const values: Array<[string, string]> = openDefinition ? [[openDefinition, line]] : [];
      for (const match of line.matchAll(/(--[\w-]+)\s*:([^;{}]*)/gu)) values.push([match[1], match[2]]);
      if (values.some(([name, value]) => RAW_HEX.test(value) && !PALETTE_TOKEN.test(name))) {
        push(index, "raw-hex-token", line);
      }
      const last = [...line.matchAll(/(--[\w-]+)\s*:/gu)].at(-1)?.[1] ?? openDefinition;
      openDefinition = line.lastIndexOf(";") >= line.lastIndexOf(":") && line.includes(";") ? null : last;
    } else {
      if (RAW_COLOR.test(line)) push(index, "raw-color", line);
      if (RAW_FONT.test(line)) push(index, "raw-font", line);
    }
    if (CUSTOM_COUNTER.test(line)) push(index, "custom-counter", line);
    for (const match of line.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/gu)) {
      const [, name, fallback] = match;
      if (!fallback && !options.knownTokens.has(name) && !local.has(name)) push(index, "unknown-token", line);
    }
  });
  for (const finding of lintListSpacing(clean)) push(finding.line, "list-spacing", finding.text);
  return findings;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

export function lintMarkup(path: string, source: string, options?: CssLintOptions): Finding[] {
  const findings: Finding[] = [];
  // <style> blocks are linted as CSS below (circled numbers included).
  const markupOnly = path.endsWith(".astro") ? source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, (block) => block.replace(/[^\n]/gu, " ")) : source;
  findings.push(...lintCircledNumbers(path, markupOnly));
  source.split("\n").forEach((line, index) => {
    if (JSX_INLINE_STYLE.test(line) || HTML_INLINE_STYLE.test(line)) {
      findings.push({ path, line: index + 1, rule: "inline-style", text: line.trim() });
    }
    if (path.includes("src/ds/") && path.endsWith(".tsx") && DS_STYLE_PROP.test(line)) {
      findings.push({ path, line: index + 1, rule: "ds-prop", text: line.trim() });
    }
  });
  // DS internals (src/ds/components) put their own classes on dynamic tags.
  const checksTags = !path.includes("src/ds/components/");
  for (const match of checksTags ? source.matchAll(COMPONENT_TAG) : []) {
    if (STYLE_ATTRIBUTE.test(match[2])) {
      findings.push({ path, line: lineOf(source, match.index), rule: "ds-prop", text: `<${match[1]}> styling prop` });
    }
  }
  if (path.endsWith(".astro")) {
    for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gu)) {
      const offset = lineOf(source, match.index) - 1;
      findings.push(...lintCss(path, match[1], options ?? { knownTokens: new Set() }, offset));
    }
  }
  return findings;
}

function walk(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, extensions);
    return extensions.some((extension) => entry.endsWith(extension)) ? [path] : [];
  });
}

export function knownTokens(): Set<string> {
  const names = new Set<string>();
  for (const scope of parseTokenScopes(readFileSync(FORK_TOKENS_PATH, "utf8")).values()) {
    for (const name of scope.keys()) names.add(name);
  }
  return names;
}

export function lintSite(root = join(SITE_ROOT, "src")): Finding[] {
  const options: CssLintOptions = { knownTokens: knownTokens() };
  return walk(root, [".css", ".tsx", ".astro", ".mdx"]).flatMap((file) => {
    const path = relative(SITE_ROOT, file);
    const source = readFileSync(file, "utf8");
    if (!file.endsWith(".css")) return lintMarkup(path, source, options);
    return lintCss(path, source, { ...options, isTokens: file === FORK_TOKENS_PATH });
  });
}

if (import.meta.main) {
  const findings = lintSite();
  if (findings.length > 0) {
    console.error("Site style lint failed:");
    for (const finding of findings) console.error(`  ${finding.path}:${finding.line} [${finding.rule}] ${finding.text}`);
    process.exit(1);
  }
  console.log("Site style lint passed.");
}
