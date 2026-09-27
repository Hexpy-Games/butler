// bun run ds:skill-catalog: rewrites the butler-design-system skill catalog.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkillCatalog } from "./skillCatalog.ts";

const target = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "skills/butler-design-system/references/catalog.md");
writeFileSync(target, await renderSkillCatalog());
console.log(`Wrote ${target}`);
