import type { ShowcaseGuidance, ShowcaseMeta, ShowcaseModule, ShowcaseStateMatrix, ShowcaseStory } from "./types";

export type ShowcaseKind = "component" | "block";

export interface ShowcaseEntry {
  /** Folder id, e.g. "components/Button"; also the DS Viewer page id. */
  id: string;
  /** Public export name, e.g. "Button". */
  name: string;
  kind: ShowcaseKind;
  sourcePath: string;
  meta: ShowcaseMeta;
  stories: ShowcaseStory[];
  stateMatrix: ShowcaseStateMatrix | null;
  guidance: ShowcaseGuidance | null;
  /** Lazily loads the raw guidance source; recipe JSX is sliced from its `#region recipe:` blocks. */
  loadGuidanceSource: (() => Promise<string>) | null;
  readme: string | null;
}

export interface ShowcaseSources {
  /** Keyed like "../components/Button/Button.showcase.tsx". */
  showcaseModules: Record<string, ShowcaseModule>;
  /** Keyed like "../components/Button/README.md". */
  readmeModules: Record<string, string>;
  /** Keyed like "../components/Button/Button.guidance.tsx". */
  guidanceModules?: Record<string, { guidance: ShowcaseGuidance }>;
  guidanceSources?: Record<string, () => Promise<string>>;
}

const SOURCE_ROOT = "packages/butler-app/client/ui/src/libs/design-system";
const FOLDER_PATTERN = /^\.\.\/(components|blocks)\/([^/]+)\//u;

function folderIdOf(key: string): string | null {
  const match = FOLDER_PATTERN.exec(key);
  return match ? `${match[1]}/${match[2]}` : null;
}

function byFolder<T>(modules: Record<string, T> | undefined): Map<string, T> {
  const result = new Map<string, T>();
  for (const [key, value] of Object.entries(modules ?? {})) {
    const id = folderIdOf(key);
    if (id) result.set(id, value);
  }
  return result;
}

/** One entry per folder that owns a showcase; categories come from each showcase's meta. */
export function collectShowcaseEntries(sources: ShowcaseSources): ShowcaseEntry[] {
  const readmes = byFolder(sources.readmeModules);
  const guidance = byFolder(sources.guidanceModules);
  const guidanceSources = byFolder(sources.guidanceSources);
  const entries = [...byFolder(sources.showcaseModules)].map(([id, module]): ShowcaseEntry => ({
    id,
    name: id.split("/")[1]!,
    kind: id.startsWith("components/") ? "component" : "block",
    sourcePath: `${SOURCE_ROOT}/${id}`,
    meta: module.meta,
    stories: module.stories,
    stateMatrix: module.stateMatrix ?? null,
    guidance: guidance.get(id)?.guidance ?? null,
    loadGuidanceSource: guidanceSources.get(id) ?? null,
    readme: readmes.get(id) ?? null,
  }));

  return entries.sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "component" ? -1 : 1,
  );
}

/** Verbatim JSX of a recipe, sliced from its `// #region recipe: <name>` block. */
export function recipeSource(source: string | null, name: string): string | null {
  if (!source) return null;
  const start = source.indexOf(`// #region recipe: ${name}\n`);
  if (start < 0) return null;
  const bodyStart = start + `// #region recipe: ${name}\n`.length;
  const end = source.indexOf("// #endregion", bodyStart);
  if (end < 0) return null;
  const lines = source.slice(bodyStart, end).replace(/\s+$/u, "").split("\n");
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent)).join("\n");
}
