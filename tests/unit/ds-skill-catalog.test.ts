import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderSkillCatalog } from "../../packages/butler-app/client/ui/src/libs/design-system/scripts/skillCatalog.ts";

// The butler-design-system skill ships a catalog generated from showcase meta
// and guidance, so agents read the same "need -> component" map as the viewer.

const designSystemRoot = resolve("packages/butler-app/client/ui/src/libs/design-system");
const catalogPath = join(designSystemRoot, "skills/butler-design-system/references/catalog.md");
const skillPath = join(designSystemRoot, "skills/butler-design-system/SKILL.md");

function folderNames(): string[] {
  return ["components", "blocks"].flatMap((kind) =>
    readdirSync(join(designSystemRoot, kind)).filter((name) => statSync(join(designSystemRoot, kind, name)).isDirectory()));
}

describe("design-system skill catalog", () => {
  test("the committed catalog matches the generator (run bun run ds:skill-catalog)", async () => {
    expect(readFileSync(catalogPath, "utf8")).toBe(await renderSkillCatalog());
  });

  test("the catalog lists every DS component and block with its import", () => {
    const catalog = readFileSync(catalogPath, "utf8");
    for (const name of folderNames()) expect({ name, listed: catalog.includes(`import { ${name} } from "@/butler-ds"`) }).toEqual({ name, listed: true });
    expect(catalog).toContain("## Decision guide");
    expect(catalog).toContain("## Build a screen");
  });

  test("the skill states the hard rules, lint gates, capability workflow and model-cost rule", () => {
    const skill = readFileSync(skillPath, "utf8");
    for (const phrase of [
      "references/catalog.md", "never create a new component", "no className", "no inline style", "Tailwind",
      "lint:ds", "lint:motion", "lint:css", "ds-showcase-coverage", "guidance.tsx", "luna", "xhigh",
      "app:design-system:smoke", "bun run render",
    ]) expect({ phrase, present: skill.includes(phrase) }).toEqual({ phrase, present: true });
  });
});
