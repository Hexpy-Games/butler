#!/usr/bin/env bun
/**
 * Deterministic prose check for the English manual (src/content/docs/en/**.mdx).
 * The writing rules live in skills/butler-docs-writing/references/english.md;
 * this script enforces the mechanical subset:
 * - banned-phrase: filler and hype from prose-lint-phrases-en.json (shared
 *   with the guide; patterns are case-insensitive)
 * - product-term: the schedules feature is never "automation(s)", and the
 *   product is never "Steward"
 * - emoji: no emoji in prose
 * It reads the same text as the Korean lint (lint-prose.ts): frontmatter,
 * code, JSX/MDX tags and props, expressions and URLs are skipped. Bold UI
 * labels and quoted UI strings are opaque to banned-phrase; product-term and
 * emoji also read inside them. The Korean rules (합니다체, list style, em dash)
 * do not apply here.
 *
 * Escape hatch, as in the Korean lint (banned-phrase and emoji only):
 *   {/* prose-lint-disable-next-line banned-phrase/<id> -- <reason> *\/}
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EMOJI,
  SITE_ROOT,
  applyDirectives,
  loadBannedPhrases,
  mask,
  walk,
  type BannedPhrase,
  type ProseFinding,
  type ProseRule,
} from "./lint-prose";

export const EN_PHRASES_PATH = join(SITE_ROOT, "scripts", "prose-lint-phrases-en.json");
export const EN_GUIDE = join(SITE_ROOT, "skills", "butler-docs-writing", "references", "english.md");
export const EN_DOCS_ROOT = join(SITE_ROOT, "src", "content", "docs", "en");

/** Product vocabulary that is wrong anywhere in prose, bold labels and quotes included. */
const PRODUCT_TERMS: Array<{ id: string; pattern: RegExp; message: string }> = [
  { id: "automation", pattern: /\bautomations?\b/iu, message: 'product term: the feature is "Schedules" (a schedule), never "automation"' },
  { id: "steward", pattern: /\bstewards?\b/iu, message: 'product term: the product is "Butler", never "Steward"' },
];

export function loadEnglishPhrases(): BannedPhrase[] {
  return loadBannedPhrases(EN_PHRASES_PATH);
}

export function lintEnglishProse(path: string, source: string, phrases = loadEnglishPhrases()): ProseFinding[] {
  const patterns = phrases.map((phrase) => ({ ...phrase, regex: new RegExp(phrase.pattern, "iu") }));
  const masked = mask(source, new Set(phrases.map((phrase) => phrase.id)));
  const findings: ProseFinding[] = [];
  const push = (line: number, rule: ProseRule, detail: string, id?: string) => {
    findings.push({ path, line, rule, message: `${path}:${line} ${detail}`, ...(id ? { id } : {}) });
  };

  masked.prose.forEach((line, index) => {
    for (const phrase of patterns) {
      if (phrase.regex.test(line)) push(index + 1, "banned-phrase", `[${phrase.id}] ${phrase.message}`, phrase.id);
    }
  });
  masked.visible.forEach((line, index) => {
    for (const term of PRODUCT_TERMS) {
      if (term.pattern.test(line)) push(index + 1, "product-term", `[${term.id}] ${term.message}`, term.id);
    }
    if (EMOJI.test(line)) push(index + 1, "emoji", "emoji in prose; manuals use words, not icons");
  });
  return applyDirectives(path, findings, masked.directives);
}

export function lintEnDocs(root = EN_DOCS_ROOT): ProseFinding[] {
  const phrases = loadEnglishPhrases();
  return walk(root).sort().flatMap((file) => lintEnglishProse(relative(SITE_ROOT, file), readFileSync(file, "utf8"), phrases));
}

if (import.meta.main) {
  const findings = lintEnDocs();
  if (findings.length > 0) {
    console.error("English prose check failed (rules: skills/butler-docs-writing/references/english.md):");
    for (const finding of findings) console.error(`  [${finding.rule}] ${finding.message}`);
    process.exit(1);
  }
  console.log(`English prose check passed (${walk(EN_DOCS_ROOT).length} en pages).`);
}
