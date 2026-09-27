// The type scale, derived from tokens.css: every `--typo-<role>-size` is a
// role, and its weight, line-height and letter-spacing tokens follow the same
// prefix. Adding a role to tokens.css adds a rung to the ladder.
import type { TokenEntry } from "./tokenCatalog";

export interface TypeRole {
  role: string;
  /** `--typo-h1` — the prefix every spec token of the role shares. */
  prefix: string;
  size: TokenEntry;
  weight?: TokenEntry;
  lineHeight?: TokenEntry;
  letterSpacing?: TokenEntry;
  /** Extra responsive steps, e.g. `--typo-new-chat-title-size-md`. */
  steps: TokenEntry[];
  /** Context overrides of the size (compact viewport, coarse pointer). */
  compact: string | null;
}

function px(value: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
  return match ? Number(match[1]) : 0;
}

export function typeRoles(catalog: TokenEntry[]): TypeRole[] {
  const byName = new Map(catalog.map((token) => [token.name, token]));
  const roles: TypeRole[] = [];
  for (const token of catalog) {
    const role = /^--typo-(.+)-size$/u.exec(token.name)?.[1];
    if (!role) continue;
    const prefix = `--typo-${role}`;
    roles.push({
      role, prefix, size: token,
      weight: byName.get(`${prefix}-weight`),
      lineHeight: byName.get(`${prefix}-line-height`),
      letterSpacing: byName.get(`${prefix}-letter-spacing`),
      steps: catalog.filter((entry) => entry.name.startsWith(`${prefix}-size-`)),
      compact: token.overrides[0]?.value ?? null,
    });
  }
  // Largest first; equal sizes keep their tokens.css order.
  return roles
    .map((role, index) => ({ role, index }))
    .sort((a, b) => px(b.role.size.light) - px(a.role.size.light) || a.index - b.index)
    .map(({ role }) => role);
}

/** `--font-weight-*` tokens as [name, value] pairs, lightest first. */
export function fontWeights(catalog: TokenEntry[]): TokenEntry[] {
  return catalog.filter((token) => /^--font-weight-/u.test(token.name)).sort((a, b) => Number(a.light) - Number(b.light));
}

/** Family names in a font stack token, generic keywords dropped. */
export function fontFamilies(stack: string): string[] {
  return stack.split(",").map((family) => family.trim().replace(/^"|"$/gu, ""))
    .filter((family) => family && !/^(ui-|system-ui|-apple-system|BlinkMacSystemFont|sans-serif|monospace|serif)/u.test(family));
}
