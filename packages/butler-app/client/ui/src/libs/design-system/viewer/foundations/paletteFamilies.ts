import type { TokenEntry } from "./tokenCatalog";

/** Palette ramps (`--blue-01` … `--blue-10`) grouped by family, in tokens.css order. */
export function paletteFamilies(catalog: TokenEntry[]): Array<{ family: string; steps: TokenEntry[] }> {
  const families = new Map<string, TokenEntry[]>();
  for (const token of catalog.filter((entry) => entry.group === "Palette")) {
    const family = /^--([a-z]+)-\d{2}$/u.exec(token.name)?.[1];
    if (family) families.set(family, [...(families.get(family) ?? []), token]);
  }
  return [...families].filter(([, steps]) => steps.length > 2).map(([family, steps]) => ({ family, steps }));
}
