import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type DesignSystemRuleFinding = {
  path: string;
  line: number;
  reason: string;
  text: string;
};

type CssRule = { selector: string; body: string; line: number };

function stripCssComments(source: string): string {
  // Keep newlines so rule line numbers stay accurate.
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function cssRules(source: string): CssRule[] {
  const css = stripCssComments(source);
  const rules: CssRule[] = [];
  for (const match of css.matchAll(/([^{};]*)\{([^{}]*)\}/gu)) {
    const selector = match[1].trim();
    const start = (match.index ?? 0) + match[1].length - match[1].trimStart().length;
    rules.push({
      selector,
      body: match[2],
      line: css.slice(0, start).split("\n").length,
    });
  }
  return rules;
}

function focusRingFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (!rule.selector.includes(":focus-visible")) return [];
  if (!/(?:^|;|\s)outline\s*:\s*none\b/u.test(rule.body)) return [];
  if (rule.body.includes("var(--focus-ring")) return [];
  return [{
    path,
    line: rule.line,
    reason: "outline: none in :focus-visible must draw the shared --focus-ring instead",
    text: rule.selector,
  }];
}

const Z_INDEX_TOKEN_THRESHOLD = 50;

function zIndexFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  return [...rule.body.matchAll(/(?:^|;|\s)z-index\s*:\s*(\d+)\s*(?:;|$)/gu)]
    .filter((match) => Number(match[1]) >= Z_INDEX_TOKEN_THRESHOLD)
    .map(() => ({
      path,
      line: rule.line,
      reason: `z-index of ${Z_INDEX_TOKEN_THRESHOLD} or more must use a var(--z-*) layering token`,
      text: rule.selector,
    }));
}

const SIZED_CONTROL_FILES = [
  "libs/design-system/components/Button/Button.module.css",
  "libs/design-system/components/IconButton/IconButton.module.css",
  "libs/design-system/components/DropdownMenu/DropdownMenu.module.css",
  "libs/design-system/components/ContextMenu/ContextMenu.module.css",
  "libs/design-system/components/Select/Select.module.css",
  "libs/design-system/blocks/OptionMenu/OptionMenu.module.css",
  "libs/design-system/blocks/FilteredSelectPopover/FilteredSelectPopover.module.css",
];

function rawHeightFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (!SIZED_CONTROL_FILES.some((file) => path.endsWith(file))) return [];
  return [...rule.body.matchAll(/(?:^|;|\s)((?:min-|max-)?height)\s*:\s*(\d+(?:\.\d+)?)px\s*(?:;|$)/gu)]
    // 1px hairline separators are not control heights.
    .filter((match) => Number(match[2]) !== 1)
    .map((match) => ({
      path,
      line: rule.line,
      reason: `raw px ${match[1]} in a control/menu stylesheet must use --control-height-* or --menu-item-height`,
      text: rule.selector,
    }));
}

const MOTION_DECLARATION = /(?:^|;|\s)((?:transition|animation)(?:-duration|-delay|-timing-function)?)\s*:\s*([^;]+)/gu;
// Any non-zero literal duration (120ms, .2s) or a raw cubic-bezier curve.
const RAW_MOTION_VALUE = /(?<![\w-])(?:(?!0+ms)\d*\.?\d+ms|\d*\.\d+s|[1-9]\d*s)(?![\w-])|cubic-bezier\(/u;

function rawMotionFindings(path: string, rule: CssRule): DesignSystemRuleFinding[] {
  if (path.endsWith("tokens.css")) return [];
  return [...rule.body.matchAll(MOTION_DECLARATION)]
    .filter((match) => RAW_MOTION_VALUE.test(match[2]))
    .map((match) => ({
      path,
      line: rule.line,
      reason: `raw ${match[1]} timing must use --motion-* duration and easing tokens`,
      text: rule.selector,
    }));
}

export function lintDesignSystemRules(path: string, source: string): DesignSystemRuleFinding[] {
  return cssRules(source).flatMap((rule) => [
    ...focusRingFindings(path, rule),
    ...zIndexFindings(path, rule),
    ...rawHeightFindings(path, rule),
    ...rawMotionFindings(path, rule),
  ]);
}

function walkCss(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "dist" || entry === "node_modules") return [];
    if (statSync(path).isDirectory()) return walkCss(path);
    return entry.endsWith(".css") ? [path] : [];
  });
}

if (import.meta.main) {
  const root = process.cwd();
  const sourceRoot = join(root, "packages", "butler-app", "client", "ui", "src");
  const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
    !process.argv.includes("--silent");
  const files = walkCss(sourceRoot);
  const findings = files.flatMap((path) =>
    lintDesignSystemRules(relative(root, path), readFileSync(path, "utf8")),
  );
  if (findings.length > 0) {
    console.error("Design-system rules lint failed:");
    for (const finding of findings) {
      console.error(`${finding.path}:${finding.line}: ${finding.reason}`);
      console.error(`  ${finding.text}`);
    }
    process.exit(1);
  }
  if (verbose) console.log(`Design-system rules lint passed for ${files.length} CSS files.`);
}
