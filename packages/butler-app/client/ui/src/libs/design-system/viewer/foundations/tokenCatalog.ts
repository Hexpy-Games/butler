// Foundations pages are generated from tokens.css (DS spec: token pages are
// not a hand-written list). The parser keeps every `--*:` definition with its
// selector and media context; the catalog folds them into one entry per token.

export interface TokenDefinition {
  name: string;
  value: string;
  selector: string;
  media: string | null;
}

export const TOKEN_CATEGORIES = [
  "color", "typography", "spacing", "radius", "shadow", "z-index", "motion", "focus", "sizing", "settings", "layout",
] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export interface TokenEntry {
  name: string;
  category: TokenCategory;
  group: string;
  /** Value in `:root` (or `.theme-light` when it overrides). */
  light: string;
  /** `.theme-dark` value when it differs from the light value. */
  dark: string | null;
  /** Other contexts: sidebar densities, media queries, solid sidebar. */
  overrides: Array<{ context: string; value: string }>;
  legacy?: { replacement: string };
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** Every custom property definition, in source order. */
export function parseTokenDefinitions(source: string): TokenDefinition[] {
  const css = stripComments(source);
  const stack: string[] = [];
  const result: TokenDefinition[] = [];
  let buffer = "";
  let depth = 0; // parenthesis depth inside a declaration value
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    const match = /^(--[\w-]+)\s*:\s*([\s\S]*)$/u.exec(text);
    if (!match || stack.length === 0) return;
    const media = [...stack].reverse().find((prelude) => prelude.startsWith("@")) ?? null;
    const selector = [...stack].reverse().find((prelude) => !prelude.startsWith("@")) ?? "";
    result.push({ name: match[1]!, value: match[2]!.replace(/\s+/gu, " ").replace(/\(\s+/gu, "(").replace(/\s+\)/gu, ")").trim(), selector, media });
  };
  for (const char of css) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth > 0) { buffer += char; continue; }
    if (char === "{") { stack.push(buffer.trim().replace(/\s+/gu, " ")); buffer = ""; continue; }
    if (char === "}") { flush(); stack.pop(); continue; }
    if (char === ";") { flush(); continue; }
    buffer += char;
  }
  return result;
}

const SHADCN_ALIASES = new Set([
  "--background", "--foreground", "--popover", "--popover-foreground", "--primary", "--primary-foreground", "--secondary",
  "--secondary-foreground", "--muted", "--muted-foreground", "--destructive", "--border", "--input", "--ring", "--radius",
]);

const RULES: Array<[TokenCategory, string, RegExp]> = [
  ["focus", "Focus ring", /^--focus-ring(-width)?$/u],
  ["color", "Semantic", /^--(focus-ring-color|color-focus-ring)$/u],
  ["z-index", "Layers", /^--z-/u],
  ["motion", "Durations", /^--motion-(instant|menu|fast|base|slow|deliberate|palette|enter-[\w-]+|exit-[\w-]+)$/u],
  ["motion", "Easings", /^--motion-ease-/u],
  ["motion", "Distances and scales", /^--motion-(distance|scale)-/u],
  ["motion", "Loops", /^--(spinner|pulse|shimmer)-/u],
  ["motion", "Panels and drag", /^--(adaptive-panel-(duration|easing)|drop-clip-margin)$/u],
  ["shadow", "Elevation", /^--shadow-|-shadow$/u],
  ["radius", "Radius", /^--radius(-|$)|^--adaptive-composer-radius$/u],
  ["typography", "Type roles", /^--typo-/u],
  ["typography", "Fonts and weights", /^--(font-|line-height-|menu-group-label-(size|weight|line-height))/u],
  ["settings", "Settings rhythm", /^--settings-(field|section)-/u],
  ["spacing", "Spacing scale", /^--space-/u],
  ["spacing", "Layout widths and gutters", /^--(layout-basis-|page-|adaptive-page-gutter|adaptive-composer-inset|tabs-line-indicator-gap|menu-group-label-padding|menu-item-padding-block)/u],
  ["spacing", "Borders", /^--border-(hairline|width-)/u],
  ["sizing", "Controls and menus", /^--(control-height-|control-hit-target|touch-target|menu-item-)/u],
  ["sizing", "Icons", /^--icon-size-/u],
  ["sizing", "Sidebar and chrome", /^--(sidebar-(row|action|icon|padding|width|titlebar)|titlebar-|chrome-(floating|toggle)|traffic-controls-width|right-panel-width|composer-reserve|adaptive-(drawer|inspector)-width|scroll-fade-size|tinted-glass-edge-size|sidebar-row-gap)/u],
  ["color", "Palette", /^--(neutral-|grayscale-|blue-|green-|red-|amber-|orange-)/u],
  ["color", "Status", /^--(color-(success|warning|danger|info)|ok$|danger|worker-|access-)/u],
  ["color", "Semantic", /^--(color-|interactive-disabled-fg$)/u],
  ["color", "Glass", /^--(composer-glass|tinted-glass)-/u],
  ["color", "Chart", /^--context-/u],
  ["color", "Syntax", /^--syntax-/u],
];

const COLOR_VALUE = /(rgba?\(|#[0-9a-f]{3,8}\b|gradient\(|color-mix\(|transparent|var\(--(color-|text-|line|accent|neutral-|grayscale-|surface|send-|danger|ok|placeholder|icon-muted))/iu;

function classify(name: string, value: string): { category: TokenCategory; group: string } {
  if (SHADCN_ALIASES.has(name)) return { category: name === "--radius" ? "radius" : name === "--ring" ? "focus" : "color", group: "Compatibility aliases" };
  for (const [category, group, pattern] of RULES) if (pattern.test(name)) return { category, group };
  if (COLOR_VALUE.test(value) || /-(bg|fg)$/u.test(name)) return { category: "color", group: "App surfaces" };
  return { category: "layout", group: "Layout and platform" };
}

/** The single token a legacy alias points at, e.g. `var(--space-md)` -> `--space-md`. */
function aliasTarget(value: string): string | null {
  return /^var\((--[\w-]+)\)$/u.exec(value)?.[1] ?? null;
}

function legacyOf(name: string, value: string): TokenEntry["legacy"] {
  if (!/^--(space|font-size)-\d$/u.test(name) && !SHADCN_ALIASES.has(name)) return undefined;
  const target = aliasTarget(value);
  return target ? { replacement: target } : undefined;
}

const BASE = ":root";

export function buildTokenCatalog(definitions: TokenDefinition[]): TokenEntry[] {
  const entries = new Map<string, TokenEntry>();
  for (const definition of definitions) {
    const context = definition.media ? `${definition.selector} ${definition.media}` : definition.selector;
    let entry = entries.get(definition.name);
    if (!entry) {
      const { category, group } = classify(definition.name, definition.value);
      entry = { name: definition.name, category, group, light: "", dark: null, overrides: [] };
      entries.set(definition.name, entry);
    }
    const plain = !definition.media;
    if (plain && definition.selector === BASE) entry.light = definition.value;
    else if (plain && definition.selector === ".theme-light") entry.light = definition.value;
    else if (plain && definition.selector === ".theme-dark") entry.dark = definition.value;
    else entry.overrides.push({ context, value: definition.value });
  }
  for (const entry of entries.values()) {
    if (!entry.light && entry.overrides.length > 0) entry.light = entry.overrides[0]!.value;
    if (entry.dark === entry.light) entry.dark = null;
    const legacy = legacyOf(entry.name, entry.light);
    if (legacy) entry.legacy = legacy;
  }
  return [...entries.values()];
}

export function tokensByCategory(catalog: TokenEntry[], category: TokenCategory): Array<{ group: string; tokens: TokenEntry[] }> {
  const groups = new Map<string, TokenEntry[]>();
  for (const entry of catalog.filter((item) => item.category === category)) {
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  }
  return [...groups].map(([group, tokens]) => ({ group, tokens }));
}
