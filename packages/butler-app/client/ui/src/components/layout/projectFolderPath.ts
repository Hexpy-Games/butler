/** Split picker paths without depending on the renderer's host platform. */
export function splitProjectFolderPath(path: string) {
  const trimmed = path.replace(/[\\/]+$/u, "");
  if (!trimmed || /^[a-z]:$/iu.test(trimmed)) return { basename: path, parent: "" };
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separatorIndex < 0) return { basename: trimmed, parent: "" };
  const parent = trimmed.slice(0, separatorIndex) || trimmed.slice(0, 1);
  return {
    basename: trimmed.slice(separatorIndex + 1),
    parent: /^[a-z]:$/iu.test(parent) ? trimmed.slice(0, separatorIndex + 1) : parent,
  };
}
