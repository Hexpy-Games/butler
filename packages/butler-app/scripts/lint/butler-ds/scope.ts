import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** UI source root; product paths and baseline keys are relative to it. */
export const UI_SOURCE_ROOT = join("packages", "butler-app", "client", "ui", "src");

export const DS_ESLINT_RULES = [
  "no-classname-on-ds",
  "no-inline-style",
  "no-raw-interactive",
  "no-raw-typography",
] as const;

export const DS_STYLELINT_RULES = [
  "token-only-values",
  "no-ds-internal-selector",
  "no-ds-custom-prop-override",
] as const;

export const DS_CONSTRAINT_RULES = [
  ...DS_ESLINT_RULES,
  "no-new-css-module",
  ...DS_STYLELINT_RULES,
] as const;

export type DsConstraintRule = (typeof DS_CONSTRAINT_RULES)[number];

type Exclusion = { pattern: string; reason: string; matches: (path: string) => boolean };

/** Everything under client/ui/src is product code except these paths. */
export const PRODUCT_EXCLUSIONS: readonly Exclusion[] = [
  {
    pattern: "libs/design-system/**",
    reason: "the design system owns its own styling",
    matches: (path) => path.startsWith("libs/design-system/"),
  },
  {
    pattern: "**/*.test.ts, **/*.test.tsx",
    reason: "tests render fixtures, not product UI",
    matches: (path) => /\.test\.tsx?$/u.test(path),
  },
  {
    pattern: "**/*.d.ts",
    reason: "type declarations carry no UI",
    matches: (path) => path.endsWith(".d.ts"),
  },
  {
    pattern: "app/fixtures.ts",
    reason: "harness data fixtures",
    matches: (path) => path === "app/fixtures.ts",
  },
  {
    pattern: "pages/*Harness.tsx, pages/*Harness.module.css",
    reason: "visual harness pages used by smokes",
    matches: (path) => /^pages\/[^/]+Harness\.(?:tsx|module\.css)$/u.test(path),
  },
];

export function isProductSource(path: string): boolean {
  return !PRODUCT_EXCLUSIONS.some((exclusion) => exclusion.matches(path));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Product files relative to the UI source root, split by language. */
export function listProductFiles(repoRoot: string): { scripts: string[]; styles: string[] } {
  const sourceRoot = join(repoRoot, UI_SOURCE_ROOT);
  const files = walk(sourceRoot)
    .map((path) => relative(sourceRoot, path).split("\\").join("/"))
    .filter(isProductSource)
    .sort();
  return {
    scripts: files.filter((path) => /\.(?:ts|tsx)$/u.test(path)),
    styles: files.filter((path) => path.endsWith(".css")),
  };
}
