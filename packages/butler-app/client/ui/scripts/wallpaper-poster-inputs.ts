import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

/** Pin engine, manifests, shaders and original photos so a build cannot silently ship stale posters. */
export function wallpaperPosterInputs(root: string): Record<string, string> {
  const directory = resolve(root, "src/libs/design-system/blocks/Wallpaper");
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile() && /\.(ts|tsx|json|frag|jpg)$/.test(file.name)
      && !/\.(test|showcase|guidance)\./.test(file.name))
    .map((file) => relative(directory, resolve(file.parentPath, file.name)).split(sep).join("/")).sort();
  return Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(resolve(directory, file))).digest("hex")]));
}
