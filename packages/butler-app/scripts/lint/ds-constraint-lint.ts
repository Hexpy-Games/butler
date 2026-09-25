import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import stylelint from "stylelint";
import tseslint from "typescript-eslint";
import { butlerDsEslintPlugin } from "./butler-ds/eslint-plugin.ts";
import { compareRatchet, ratchetFailures, shrinkBaseline, type FileCounts } from "./butler-ds/ratchet.ts";
import {
  DS_CONSTRAINT_RULES,
  DS_ESLINT_RULES,
  DS_STYLELINT_RULES,
  UI_SOURCE_ROOT,
  listProductFiles,
  type DsConstraintRule,
} from "./butler-ds/scope.ts";
import { butlerDsStylelintPlugins } from "./butler-ds/stylelint-plugin.ts";

const root = process.cwd();
const sourceRoot = join(root, UI_SOURCE_ROOT);
const baselineDir = join(root, "packages", "butler-app", "scripts", "lint", "butler-ds", "baseline");
const updateBaseline = process.argv.includes("--update-baseline");
const allowGrowth = process.argv.includes("--allow-growth");
const summary = process.argv.includes("--summary");
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");

type Counts = Record<DsConstraintRule, FileCounts>;

function emptyCounts(): Counts {
  return Object.fromEntries(DS_CONSTRAINT_RULES.map((rule) => [rule, {}])) as Counts;
}

function bump(counts: FileCounts, file: string): void {
  counts[file] = (counts[file] ?? 0) + 1;
}

async function collect(): Promise<{ counts: Counts; errors: string[] }> {
  const { scripts, styles } = listProductFiles(root);
  const counts = emptyCounts();
  const errors: string[] = [];

  const eslint = new ESLint({
    cwd: sourceRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      // Inline disable comments cannot bypass the ratchet.
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
      plugins: { "butler-ds": butlerDsEslintPlugin },
      rules: Object.fromEntries(DS_ESLINT_RULES.map((rule) => [`butler-ds/${rule}`, "error"])),
    }],
  });
  for (const result of await eslint.lintFiles(scripts)) {
    const file = result.filePath.slice(sourceRoot.length + 1).split("\\").join("/");
    for (const message of result.messages) {
      const rule = message.ruleId?.replace(/^butler-ds\//u, "") as DsConstraintRule | undefined;
      if (message.fatal || !rule || !(rule in counts)) {
        errors.push(`${file}:${message.line}: ${message.message}`);
        continue;
      }
      bump(counts[rule], file);
    }
  }

  for (const file of styles.filter((path) => path.endsWith(".module.css"))) bump(counts["no-new-css-module"], file);

  const lint = await stylelint.lint({
    files: styles.map((file) => join(sourceRoot, file)),
    ignoreDisables: true,
    config: {
      plugins: butlerDsStylelintPlugins,
      rules: Object.fromEntries(DS_STYLELINT_RULES.map((rule) => [`butler-ds/${rule}`, true])),
    },
  });
  for (const result of lint.results) {
    const file = (result.source ?? "").slice(sourceRoot.length + 1);
    for (const warning of result.warnings) {
      const rule = warning.rule.replace(/^butler-ds\//u, "") as DsConstraintRule;
      if (!(rule in counts)) {
        errors.push(`${file}:${warning.line}: ${warning.text}`);
        continue;
      }
      bump(counts[rule], file);
    }
  }
  return { counts, errors };
}

function baselinePath(rule: DsConstraintRule): string {
  return join(baselineDir, `${rule}.json`);
}

function readBaseline(rule: DsConstraintRule): FileCounts {
  const path = baselinePath(rule);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as FileCounts : {};
}

function writeBaseline(rule: DsConstraintRule, counts: FileCounts): void {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath(rule), `${JSON.stringify(sorted, null, 2)}\n`);
}

function total(counts: FileCounts): { files: number; violations: number } {
  const values = Object.values(counts);
  return { files: values.length, violations: values.reduce((sum, value) => sum + value, 0) };
}

const { counts, errors } = await collect();
if (errors.length > 0) {
  console.error("DS constraint lint could not check every file:");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

if (summary) {
  console.log(JSON.stringify(Object.fromEntries(DS_CONSTRAINT_RULES.map((rule) => [rule, total(counts[rule])])), null, 2));
}

if (updateBaseline) {
  const refused: string[] = [];
  for (const rule of DS_CONSTRAINT_RULES) {
    const next = shrinkBaseline(readBaseline(rule), counts[rule], { allowGrowth });
    refused.push(...next.refused.map((entry) => `${rule}: ${entry}`));
    writeBaseline(rule, next.next);
  }
  if (refused.length > 0) {
    console.error("DS constraint baseline only shrinks; these increases were not recorded (fix them instead):");
    for (const entry of refused) console.error(`  ${entry}`);
    process.exit(1);
  }
  if (verbose) console.log("DS constraint baseline updated.");
  process.exit(0);
}

const failures = DS_CONSTRAINT_RULES.flatMap((rule) =>
  ratchetFailures(rule, compareRatchet(readBaseline(rule), counts[rule])));
if (failures.length > 0) {
  console.error("DS constraint lint failed (see packages/butler-app/scripts/lint/README.md):");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

if (verbose) {
  for (const rule of DS_CONSTRAINT_RULES) {
    const { files, violations } = total(counts[rule]);
    console.log(`butler-ds/${rule}: ${violations} baseline violation(s) in ${files} file(s)`);
  }
}
