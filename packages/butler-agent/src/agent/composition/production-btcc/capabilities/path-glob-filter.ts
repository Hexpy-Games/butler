import { basename, matchesGlob } from "node:path";

export function pathMatchesFilters(
  path: string,
  filters: { includeGlobs: string[]; excludeGlobs: string[] },
): boolean {
  const included = filters.includeGlobs.length === 0 ||
    filters.includeGlobs.some((glob) => matchesWorkspacePath(path, glob));
  const excluded = filters.excludeGlobs.some((glob) => matchesWorkspacePath(path, glob));
  return included && !excluded;
}

function matchesWorkspacePath(path: string, glob: string): boolean {
  return glob.includes("/")
    ? matchesGlob(path, glob)
    : matchesGlob(basename(path), glob);
}
