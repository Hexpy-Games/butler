import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "packages", "butler-app", "client", "ui", "src");
const extensions = new Set([".css", ".js", ".jsx", ".ts", ".tsx"]);
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");

type Finding = {
  path: string;
  line: number;
  reason: string;
  text: string;
};

const rawColorValue = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(^|[^\w-])(white|black)(?![\w-])/i;
const rawHexColorValue = /#[0-9a-fA-F]{3,8}\b/;
const rawFontValue =
  /font-size\s*:\s*(?!var\()[^;]*(?:\b\d+(?:\.\d+)?(?:px|rem|em)\b|clamp\()|font-family\s*:|font-weight\s*:\s*(?!\s*(?:var\(|inherit|unset|initial|revert))|font\s*:\s*(?!\s*(?:var\(|inherit|unset|initial|revert))/i;
const rawColorUtility =
  /\b(?:bg|text|border|ring|fill|stroke)-(?:black|white|red|blue|green|yellow|orange|purple|pink|gray|slate|zinc|neutral|stone)(?:\/\d+)?\b/;
const rawInlineStyle =
  /style\s*=\s*\{\{[^}]*\b(?:color|background(?:Color)?|borderColor|fontSize|fontFamily|font)\s*:\s*["'`]/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "dist" || entry === "node_modules") continue;
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const extension = dot === -1 ? "" : entry.slice(dot);
    if (extensions.has(extension)) files.push(path);
  }
  return files;
}

function isCssVariableDefinition(line: string): boolean {
  return /^\s*--[\w-]+\s*:/.test(line);
}

function cssVariableName(line: string): string | null {
  const match = /^\s*(--[\w-]+)\s*:/.exec(line);
  return match?.[1] ?? null;
}

function isSourceColorTokenName(name: string): boolean {
  return /^(?:--neutral-|--grayscale-|--blue-|--green-|--red-|--amber-|--orange-)/u.test(
    name,
  );
}

function stripCssCommentsFromLine(line: string, state: { inBlockComment: boolean }): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf("*/", cursor);
      if (end === -1) return output;
      state.inBlockComment = false;
      cursor = end + 2;
      continue;
    }
    const start = line.indexOf("/*", cursor);
    if (start === -1) {
      output += line.slice(cursor);
      break;
    }
    output += line.slice(cursor, start);
    const end = line.indexOf("*/", start + 2);
    if (end === -1) {
      state.inBlockComment = true;
      break;
    }
    cursor = end + 2;
  }
  return output;
}

function lintCss(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  let inCssVariableDefinition = false;
  const commentState = { inBlockComment: false };
  source.split("\n").forEach((line, index) => {
    const lintLine = stripCssCommentsFromLine(line, commentState);
    if (isCssVariableDefinition(lintLine)) {
      const variableName = cssVariableName(lintLine);
      if (
        path.endsWith("tokens.css") &&
        variableName &&
        rawHexColorValue.test(lintLine) &&
        !isSourceColorTokenName(variableName)
      ) {
        findings.push({
          path,
          line: index + 1,
          reason:
            "raw hex color in tokens.css must live in a source palette token",
          text: line.trim(),
        });
      }
      inCssVariableDefinition = !lintLine.includes(";");
      return;
    }
    if (inCssVariableDefinition) {
      if (lintLine.includes(";")) inCssVariableDefinition = false;
      return;
    }
    if (rawColorValue.test(lintLine)) {
      findings.push({
        path,
        line: index + 1,
        reason: "raw color value must be promoted to a design token",
        text: line.trim(),
      });
    }
    if (rawFontValue.test(lintLine)) {
      findings.push({
        path,
        line: index + 1,
        reason: "raw typography value must use design-system typography tokens",
        text: line.trim(),
      });
    }
  });
  return findings;
}

function lintScript(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  source.split("\n").forEach((line, index) => {
    if (rawColorUtility.test(line)) {
      findings.push({
        path,
        line: index + 1,
        reason: "raw color utility class must be replaced by token-backed styling",
        text: line.trim(),
      });
    }
    if (rawInlineStyle.test(line)) {
      findings.push({
        path,
        line: index + 1,
        reason: "inline color or typography style must use design tokens",
        text: line.trim(),
      });
    }
  });
  return findings;
}

const files = walk(sourceRoot);
const findings = files.flatMap((path) => {
  const source = readFileSync(path, "utf8");
  const relPath = relative(root, path);
  return path.endsWith(".css") ? lintCss(relPath, source) : lintScript(relPath, source);
});

if (findings.length > 0) {
  console.error("Design token lint failed:");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.reason}`);
    console.error(`  ${finding.text}`);
  }
  process.exit(1);
}

if (verbose) console.log(`Design token lint passed for ${files.length} source files.`);
