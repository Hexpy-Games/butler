#!/usr/bin/env bun
/**
 * UI label lookup for translators. Bold text in the manual is an exact UI
 * label: Korean pages take it from packages/butler-i18n/src/locales/ko.ts,
 * English pages from en.ts. The two files share keys, so a Korean label maps
 * to its English label through the key.
 *
 *   bun run labels            report bold labels in en pages that are not an
 *                             exact en.ts string (review list; exits 0)
 *   bun run labels --write    regenerate references/english-ui-labels.md from
 *                             the bold labels in ko pages
 *   bun run labels 예약 작업    look up one Korean label
 *
 * Function-valued copy (templates with a count or a name) is rendered with
 * {0}, {1}, {2} placeholders; a label written with N or a number matches it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SITE_ROOT, walk } from "./lint-prose";

const LOCALES_DIR = join(SITE_ROOT, "..", "butler-i18n", "src", "locales");
const DOCS_ROOT = join(SITE_ROOT, "src", "content", "docs");
export const LABELS_REFERENCE = join(SITE_ROOT, "skills", "butler-docs-writing", "references", "english-ui-labels.md");

type Copy = Map<string, string>;

function flatten(value: unknown, key: string, out: Copy): Copy {
  if (typeof value === "string") out.set(key, value);
  else if (typeof value === "function") {
    try {
      const rendered = (value as (...args: string[]) => unknown)("{0}", "{1}", "{2}");
      if (typeof rendered === "string") out.set(`${key}()`, rendered);
    } catch {
      // A template that needs structured arguments: not a plain label.
    }
  } else if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${key}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) flatten(item, key ? `${key}.${name}` : name, out);
  }
  return out;
}

export async function loadCopy(): Promise<{ ko: Copy; en: Copy }> {
  // Loaded by path so the site's typecheck does not take on the app's copy contract.
  const [ko, en] = await Promise.all([import(join(LOCALES_DIR, "ko.ts")), import(join(LOCALES_DIR, "en.ts"))]);
  return { ko: flatten(ko.koKrCopy, "", new Map()), en: flatten(en.enUsCopy, "", new Map()) };
}

/** Bold spans outside frontmatter and code, split on the " → " of a menu path. */
export function boldLabels(source: string): string[] {
  const body = source
    .replace(/^---\n[\s\S]*?\n---(?=\n|$)/u, "")
    .replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1\s*$/gmu, "")
    .replace(/`[^`\n]*`/gu, "");
  return [...body.matchAll(/\*\*(?=\S)([^\n]*?\S)\*\*/gu)].flatMap((match) => match[1].split(/\s*→\s*/u));
}

function pageLabels(locale: string): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const file of walk(join(DOCS_ROOT, locale)).sort()) {
    const page = relative(join(DOCS_ROOT, locale), file).replace(/\.mdx$/u, "");
    for (const label of boldLabels(readFileSync(file, "utf8"))) {
      const pages = labels.get(label) ?? [];
      if (!pages.includes(page)) pages.push(page);
      labels.set(label, pages);
    }
  }
  return labels;
}

/** Keys whose Korean string is this label; a label with N or digits also matches a {0} template. */
export function keysFor(label: string, ko: Copy): string[] {
  const exact = [...ko].filter(([, text]) => text === label).map(([key]) => key);
  if (exact.length > 0 || !/N|\d/u.test(label)) return exact;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/N|\d+/gu, "(?:\\{\\d\\}|N|\\d+)");
  const template = new RegExp(`^${escaped}$`, "u");
  return [...ko].filter(([key, text]) => key.endsWith("()") && template.test(text)).map(([key]) => key);
}

/** English strings for a Korean label, each with the keys that carry it. */
export function englishFor(label: string, copy: { ko: Copy; en: Copy }): Array<{ text: string; keys: string[] }> {
  const variants = new Map<string, string[]>();
  for (const key of keysFor(label, copy.ko)) {
    const text = copy.en.get(key);
    if (text !== undefined) variants.set(text, [...(variants.get(text) ?? []), key]);
  }
  return [...variants].map(([text, keys]) => ({ text, keys }));
}

const cell = (text: string) => text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");

export function labelTable(copy: { ko: Copy; en: Copy }): string {
  const rows: string[] = [];
  const unmatched: string[] = [];
  for (const [label, pages] of [...pageLabels("ko")].sort(([a], [b]) => a.localeCompare(b, "ko"))) {
    const variants = englishFor(label, copy);
    if (variants.length === 0) unmatched.push(`| ${cell(label)} | ${pages.join(", ")} |`);
    else {
      const english = variants.length === 1
        ? `**${cell(variants[0].text)}**`
        : variants.map(({ text, keys }) => `**${cell(text)}** (\`${keys[0]}\`)`).join("<br />");
      rows.push(`| ${cell(label)} | ${english} | ${pages.join(", ")} |`);
    }
  }
  return [
    "# UI labels: Korean → English",
    "",
    "Generated by `bun run labels --write` (packages/butler-site/scripts/ui-labels.ts)",
    "from the bold labels in the Korean pages and the shared keys of",
    "`packages/butler-i18n/src/locales/ko.ts` and `en.ts`. Do not edit by hand;",
    "regenerate after the app copy or the Korean pages change.",
    "",
    "- One English string: use it as is, in bold.",
    "- Several strings: the same Korean word labels different controls. The key",
    "  after each one names where it appears; pick the one for the control the",
    "  Korean sentence describes, and confirm it in `en.ts`.",
    "- `{0}` is a value the app fills in (a count, a name).",
    "",
    "| Korean label | English label | Pages |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Not a ko.ts string",
    "",
    "Bold text the lookup cannot resolve: macOS and third-party labels, provider",
    "and theme names, and examples with sample values. Provider, product and",
    "theme names stay as they are. For macOS labels use Apple's English wording.",
    "For the rest, find the template in `ko.ts` by its fixed words and take the",
    "same key from `en.ts`.",
    "",
    "| Korean bold text | Pages |",
    "| --- | --- |",
    ...unmatched,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const copy = await loadCopy();
  const [argument, ...rest] = process.argv.slice(2);
  if (argument === "--write") {
    writeFileSync(LABELS_REFERENCE, labelTable(copy));
    console.log(`Wrote ${relative(SITE_ROOT, LABELS_REFERENCE)}.`);
  } else if (argument !== undefined) {
    const label = [argument, ...rest].join(" ");
    const variants = englishFor(label, copy);
    if (variants.length === 0) console.log(`No ko.ts string is exactly "${label}".`);
    for (const { text, keys } of variants) console.log(`${text}\t${keys.join(", ")}`);
  } else {
    const english = new Set(copy.en.values());
    const unknown = [...pageLabels("en")].filter(([label]) => !english.has(label));
    console.log(`Bold labels in en pages that are not an exact en.ts string (${unknown.length}); check each against en.ts or the OS wording:`);
    for (const [label, pages] of unknown) console.log(`  ${label}\t${pages.join(", ")}`);
  }
}
