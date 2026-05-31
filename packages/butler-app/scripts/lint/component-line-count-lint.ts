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
const LINE_LIMIT = 160;
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");

type Finding = {
  path: string;
  lineCount: number;
};

function isHookFile(entry: string): boolean {
  return /^use[A-Z][A-Za-z0-9]*\.tsx?$/u.test(entry);
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  const newlineMatches = source.match(/\n/gu);
  const newlineCount = newlineMatches ? newlineMatches.length : 0;
  return source.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    // Skip test files, spec files, and generated/dist/node_modules
    if (
      entry === "dist" ||
      entry === "node_modules" ||
      entry === "ui" || // Legacy shadcn location; retained for older worktrees
      entry === "hooks" || // Hook files are exempt from component line limits
      entry.includes(".test.") ||
      entry.includes(".spec.")
    ) continue;

    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
      continue;
    }

    // Only check TypeScript/TSX component files
    if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !isHookFile(entry)
    ) {
      files.push(path);
    }
  }
  return files;
}

function checkComponentLineCount(path: string): Finding | null {
  const source = readFileSync(path, "utf8");
  const lineCount = countLines(source);

  if (lineCount > LINE_LIMIT) {
    return {
      path: relative(root, path),
      lineCount,
    };
  }

  return null;
}

const findings = componentRoots
  .flatMap(walk)
  .map(checkComponentLineCount)
  .filter((finding): finding is Finding => finding !== null)
  .sort((left, right) => right.lineCount - left.lineCount);

if (findings.length > 0) {
  console.error("Component line count lint failed:");
  console.error("==================================");
  for (const finding of findings) {
    console.error(
      `${finding.path}: ${finding.lineCount} lines (exceeds ${LINE_LIMIT} line limit)`,
    );
  }
  console.error("");
  console.error(
    `Found ${findings.length} component(s) exceeding the ${LINE_LIMIT} line threshold.`,
  );
  console.error("Refactor these components to improve maintainability.");
  process.exit(1);
}

const totalFiles = componentRoots.flatMap(walk).length;
if (verbose) console.log(`Component line count lint passed for ${totalFiles} component files.`);
