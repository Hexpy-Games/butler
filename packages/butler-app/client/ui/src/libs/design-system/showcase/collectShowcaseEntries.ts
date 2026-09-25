import type { ShowcaseCategory, ShowcaseMeta, ShowcaseModule, ShowcaseStory } from "./types";

export type ShowcaseKind = "component" | "block";

/** Where an entry's stories come from while registry fixtures are migrated. */
export type ShowcaseOrigin = "showcase" | "registry" | "none";

export interface ShowcaseEntry {
  /** Folder id, e.g. "components/Button"; also the DS Viewer page id. */
  id: string;
  /** Public export name, e.g. "Button". */
  name: string;
  kind: ShowcaseKind;
  sourcePath: string;
  meta: ShowcaseMeta;
  stories: ShowcaseStory[];
  readme: string | null;
  origin: ShowcaseOrigin;
}

export interface ShowcaseSources {
  /** Keyed like "../components/Button/Button.showcase.tsx". */
  showcaseModules: Record<string, ShowcaseModule>;
  /** Keyed like "../components/Button/README.md". */
  readmeModules: Record<string, string>;
  /** Temporary adapters for registry.tsx fixtures, keyed by folder id. */
  fallbacks: Record<string, ShowcaseModule>;
  /**
   * Category for every folder without a showcase file, keyed by folder id.
   * Its keys also list those folders, so nothing needs an extra module glob.
   */
  legacyCategories: Record<string, ShowcaseCategory>;
}

const SOURCE_ROOT = "packages/butler-app/client/ui/src/libs/design-system";
const FOLDER_PATTERN = /^\.\.\/(components|blocks)\/([^/]+)\//u;

function folderIdOf(key: string): string | null {
  const match = FOLDER_PATTERN.exec(key);
  return match ? `${match[1]}/${match[2]}` : null;
}

function byFolder<T>(modules: Record<string, T>): Map<string, T> {
  const result = new Map<string, T>();
  for (const [key, value] of Object.entries(modules)) {
    const id = folderIdOf(key);
    if (id) result.set(id, value);
  }
  return result;
}

export function collectShowcaseEntries(sources: ShowcaseSources): ShowcaseEntry[] {
  const showcases = byFolder(sources.showcaseModules);
  const readmes = byFolder(sources.readmeModules);
  const ids = new Set([
    ...showcases.keys(),
    ...Object.keys(sources.fallbacks),
    ...Object.keys(sources.legacyCategories),
  ]);

  const entries = [...ids].map((id): ShowcaseEntry => {
    const name = id.split("/")[1];
    const showcase = showcases.get(id);
    const fallback = sources.fallbacks[id];
    const module = showcase ?? fallback;
    return {
      id,
      name,
      kind: id.startsWith("components/") ? "component" : "block",
      sourcePath: `${SOURCE_ROOT}/${id}`,
      meta: module?.meta ?? { title: name, category: sources.legacyCategories[id] ?? "Layout" },
      stories: module?.stories ?? [],
      readme: readmes.get(id) ?? null,
      origin: showcase ? "showcase" : fallback ? "registry" : "none",
    };
  });

  return entries.sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "component" ? -1 : 1,
  );
}
