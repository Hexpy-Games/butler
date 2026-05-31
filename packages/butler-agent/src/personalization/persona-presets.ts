import { readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { butlerAgentResourcesPath } from "../runtime/paths.ts";

export type PersonaPresetLocale = "en" | "ko";

export interface PersonaPresetTemplate {
  name: string;
  label: string;
  description: string;
  preview: string;
  locale: PersonaPresetLocale;
  content: string;
}

export const PERSONA_PRESET_ORDER = [
  "butler",
  "guardian",
  "demon-butler",
  "wolf-butler",
  "neko-servant",
  "think-tank",
  "operator",
  "archivist",
  "dry-wit",
] as const;

export function readPersonaPresets(
  butlerHome: string,
  locale: PersonaPresetLocale,
): PersonaPresetTemplate[] {
  const root = resolve(butlerAgentResourcesPath(butlerHome, "personas", "templates"));
  const localeDir = resolve(root, locale);
  const fallbackDir = resolve(root, "en");
  const names = new Set<string>();
  for (const dir of [fallbackDir, localeDir]) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".md")) names.add(file.replace(/\.md$/u, ""));
      }
    } catch {
      // Missing optional preset directories should not break personalization.
    }
  }
  const ordered = [
    ...PERSONA_PRESET_ORDER.filter((name) => names.has(name)),
    ...[...names]
      .filter((name) => !PERSONA_PRESET_ORDER.some((presetName) => presetName === name))
      .sort(),
  ];
  return ordered.flatMap((name) => {
    const preset = readPersonaPreset(butlerHome, locale, name);
    return preset ? [preset] : [];
  });
}

export function readPersonaPreset(
  butlerHome: string,
  locale: PersonaPresetLocale,
  name: string,
): PersonaPresetTemplate | null {
  const root = resolve(butlerAgentResourcesPath(butlerHome, "personas", "templates"));
  const safeName = safePersonaPresetName(name);
  if (!safeName) return null;
  for (const candidateLocale of uniqueLocales([locale, "en"])) {
    const path = resolve(root, candidateLocale, `${safeName}.md`);
    if (!isPathInside(root, path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const { frontmatter, body } = parseMarkdownFrontmatter(raw);
      return {
        name: safeName,
        label: labelForPersonaPreset(frontmatter.name ?? safeName),
        description: frontmatter.description ?? "",
        preview: frontmatter.preview ?? "",
        locale: candidateLocale,
        content: activePersonaTemplate(safeName, candidateLocale, body),
      };
    } catch {
      // Try the next locale.
    }
  }
  return null;
}

export function safePersonaPresetName(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(trimmed)) return null;
  return trimmed;
}

function parseMarkdownFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) return { frontmatter: {}, body: text.trimStart() };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!entry) continue;
    const value = entry[2]!.trim().replace(/^"|"$/gu, "");
    frontmatter[entry[1]!] = value;
  }
  return {
    frontmatter,
    body: text.slice(match[0].length).trimStart(),
  };
}

function activePersonaTemplate(
  presetName: string,
  locale: PersonaPresetLocale,
  body: string,
): string {
  return [
    "---",
    "name: active",
    `base: ${presetName}`,
    `base_locale: ${locale}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function labelForPersonaPreset(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function uniqueLocales(locales: PersonaPresetLocale[]): PersonaPresetLocale[] {
  return [...new Set(locales)];
}

function isPathInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  );
}
