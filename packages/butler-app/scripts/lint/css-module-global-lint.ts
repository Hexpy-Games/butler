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
  text: string;
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    // Skip the legacy components/ui directory in older worktrees.
    if (entry === "ui") continue;

    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
      continue;
    }

    // Only check CSS module files
    if (entry.endsWith(".module.css")) {
      files.push(path);
    }
  }
  return files;
}

function stripCssCommentsFromLine(
  line: string,
  state: { inBlockComment: boolean },
): string {
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

function checkCssModuleGlobal(path: string): Finding[] {
  const source = readFileSync(path, "utf8");
  const findings: Finding[] = [];
  const commentState = { inBlockComment: false };

  source.split("\n").forEach((line, index) => {
    const lintLine = stripCssCommentsFromLine(line, commentState);

    if (/:global\s*\(/.test(lintLine)) {
      findings.push({
        path: relative(root, path),
        line: index + 1,
        text: line.trim(),
      });
    }

  });

  return findings;
}

const findings = componentRoots.flatMap(walk).flatMap(checkCssModuleGlobal);

if (findings.length > 0) {
  console.error("CSS module global boundary lint failed:");
  console.error("=========================================");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line}: :global selector in component CSS module`);
    console.error(`  ${finding.text}`);
  }
  console.error("");
  console.error(
    `Found ${findings.length} :global selector(s) in component CSS modules.`,
  );
  console.error(
    "Move these styles to wrapper components or target primitive slots from a local class.",
  );
  process.exit(1);
}

const totalFiles = componentRoots.flatMap(walk).length;
if (verbose) {
  console.log(
    `CSS module global boundary lint passed for ${totalFiles} CSS module files.`,
  );
}
