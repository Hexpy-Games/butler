// test-category: format-pin
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { areas, parts } from "../../packages/butler-app/client/ui/src/libs/design-system/glossary/glossary";
import { renderGlossary } from "../../packages/butler-app/client/ui/src/libs/design-system/scripts/glossaryMarkdown";

const root = "packages/butler-app/client/ui/src/libs/design-system";

test("the agent glossary stays in sync (bun run ds:glossary)", () => {
  expect(readFileSync(`${root}/skills/butler-design-system/references/glossary.md`, "utf8")).toBe(renderGlossary());
});

test("canonical glossary ids and hierarchy are retained", () => {
  expect(areas).toHaveLength(13);
  expect(parts).toHaveLength(156);
  expect(new Set(parts.map((part) => part.id)).size).toBe(parts.length);
  for (const part of parts) {
    expect(areas.some((area) => area.id === part.area)).toBe(true);
    const visited = new Set([part.id]);
    let parent = part.parent;
    while (parent) {
      expect(visited.has(parent)).toBe(false);
      visited.add(parent);
      const ancestor = parts.find((item) => item.id === parent);
      expect(ancestor?.area).toBe(part.area);
      parent = ancestor!.parent;
    }
  }
});
