import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const componentsPath = join(root, "packages", "butler-app", "client", "ui", "src", "components");
const designSystemComponentsPath = join(
  root,
  "packages",
  "butler-app",
  "client",
  "ui",
  "src",
  "libs",
  "design-system",
  "components",
);
const designSystemBlocksPath = join(
  root,
  "packages",
  "butler-app",
  "client",
  "ui",
  "src",
  "libs",
  "design-system",
  "blocks",
);
const componentRoots = [
  componentsPath,
  designSystemComponentsPath,
  designSystemBlocksPath,
];
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");

type Finding = {
  path: string;
  line: number;
  prop: string;
  reason: string;
  text: string;
};

// Store-readable props that should not be passed through components
const STORE_READABLE_PROPS = new Set([
  "settings",
  "modelCatalog",
  "activeChatId",
  "activeChat",
  "activeView",
  "navigation",
  "status",
  "summary",
  "tab",
]);

// Handler bundle props that indicate prop-heavy pass-through
const HANDLER_BUNDLE_PROPS = new Set([
  "handlers",
  "callbacks",
  "onActions",
]);

function isHookFile(entry: string): boolean {
  return /^use[A-Z][A-Za-z0-9]*\.tsx?$/u.test(entry);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    // Skip test files, spec files, and the legacy components/ui directory.
    if (
      entry === "ui" ||
      entry === "dist" ||
      entry === "node_modules" ||
      entry.includes(".test.") ||
      entry.includes(".spec.")
    ) {
      continue;
    }

    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
      continue;
    }

    // Only check TypeScript/TSX component files, excluding hooks
    if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !isHookFile(entry)) {
      files.push(path);
    }
  }
  return files;
}

function checkPropBoundary(path: string): Finding[] {
  const source = readFileSync(path, "utf8");
  const findings: Finding[] = [];

  // Match optional prop patterns in interfaces/types:
  // - propName?: Type
  // - propName? : Type (with space)
  const optionalPropPattern = /^\s*(\w+)\?\s*:\s*/;

  let inInterface = false;
  let braceDepth = 0;

  source.split("\n").forEach((line, index) => {
    // Track when we're inside interface/type definitions
    if (/^(?:export\s+)?(?:interface|type)\s+\w+/.test(line)) {
      inInterface = true;
      braceDepth = 0;
    }

    if (inInterface) {
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      if (braceDepth <= 0) {
        inInterface = false;
      }
    }

    // Only check lines inside interfaces/types
    if (!inInterface) return;

    const match = line.match(optionalPropPattern);
    if (!match) return;

    const propName = match[1];

    if (STORE_READABLE_PROPS.has(propName)) {
      findings.push({
        path: relative(root, path),
        line: index + 1,
        prop: propName,
        reason: "store-readable prop should not be passed through components",
        text: line.trim(),
      });
    } else if (HANDLER_BUNDLE_PROPS.has(propName)) {
      findings.push({
        path: relative(root, path),
        line: index + 1,
        prop: propName,
        reason: "handler bundle indicates prop-heavy pass-through surface",
        text: line.trim(),
      });
    }
  });

  return findings;
}

const findings = componentRoots.flatMap(walk).flatMap(checkPropBoundary);

if (findings.length > 0) {
  console.error("Prop boundary lint failed:");
  console.error("==========================");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.reason}`);
    console.error(`  Prop: ${finding.prop}`);
    console.error(`  ${finding.text}`);
  }
  console.error("");
  console.error(
    `Found ${findings.length} prop boundary violation(s) in component interfaces.`,
  );
  console.error(
    "Use focused store selectors and domain hooks instead of passing store-readable props.",
  );
  process.exit(1);
}

const totalFiles = componentRoots.flatMap(walk).length;
if (verbose) {
  console.log(
    `Prop boundary lint passed for ${totalFiles} component files.`,
  );
}
