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

export function lintDesignSystemRules(path: string, source: string): DesignSystemRuleFinding[] {
  return cssRules(source).flatMap((rule) => focusRingFindings(path, rule));
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
