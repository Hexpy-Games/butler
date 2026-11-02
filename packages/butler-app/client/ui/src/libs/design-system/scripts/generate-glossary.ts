// bun run ds:glossary: rewrites the agent glossary from the viewer's data.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderGlossary } from "./glossaryMarkdown";

const target = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "skills/butler-design-system/references/glossary.md");
writeFileSync(target, renderGlossary());
console.log(`Wrote ${target}`);
