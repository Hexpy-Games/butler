/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { collectShowcaseEntries, recipeSource } from "./collectShowcaseEntries";
import type { ShowcaseGuidance, ShowcaseModule } from "./types";

const buttonShowcase: ShowcaseModule = {
  meta: { title: "Button", category: "Action", tags: ["action"], status: "stable" },
  stories: [{ name: "Variants", render: () => "button" }],
  stateMatrix: { states: ["default", "hover"], render: () => "matrix" },
};

const navRowShowcase: ShowcaseModule = {
  meta: { title: "NavRow", category: "Navigation", tags: ["navigation"] },
  stories: [{ name: "Default", render: () => "nav row" }],
};

const guidance = { purpose: "Run an action." } as ShowcaseGuidance;

function collect() {
  return collectShowcaseEntries({
    showcaseModules: {
      "../blocks/NavRow/NavRow.showcase.tsx": navRowShowcase,
      "../components/Button/Button.showcase.tsx": buttonShowcase,
    },
    readmeModules: { "../components/Button/README.md": "# Button" },
    guidanceModules: { "../components/Button/Button.guidance.tsx": { guidance } },
    guidanceSources: { "../components/Button/Button.guidance.tsx": async () => "source" },
  });
}

describe("collectShowcaseEntries", () => {
  test("lists one entry per showcase folder, components first", () => {
    expect(collect().map((entry) => entry.id)).toEqual(["components/Button", "blocks/NavRow"]);
  });

  test("takes the category, stories and states matrix from the showcase module", () => {
    const [button, navRow] = collect();
    expect(button?.meta.category).toBe("Action");
    expect(button?.stories.map((story) => story.name)).toEqual(["Variants"]);
    expect(button?.stateMatrix?.states).toEqual(["default", "hover"]);
    expect(navRow?.kind).toBe("block");
    expect(navRow?.stateMatrix).toBeNull();
  });

  test("attaches the README, guidance, source path and public import name", async () => {
    const [button, navRow] = collect();
    expect(button?.name).toBe("Button");
    expect(button?.readme).toBe("# Button");
    expect(button?.guidance?.purpose).toBe("Run an action.");
    expect(await button?.loadGuidanceSource?.()).toBe("source");
    expect(button?.sourcePath).toBe("packages/butler-app/client/ui/src/libs/design-system/components/Button");
    expect(navRow?.guidance).toBeNull();
    expect(navRow?.readme).toBeNull();
  });
});

describe("recipeSource", () => {
  const source = [
    "export const x = 1;",
    "  // #region recipe: Settings row",
    "  function SettingsRow() {",
    "    return <Row />;",
    "  }",
    "  // #endregion",
  ].join("\n");

  test("returns the dedented JSX between the recipe region markers", () => {
    expect(recipeSource(source, "Settings row")).toBe("function SettingsRow() {\n  return <Row />;\n}");
  });

  test("returns null when the recipe has no region", () => {
    expect(recipeSource(source, "Missing")).toBeNull();
    expect(recipeSource(null, "Settings row")).toBeNull();
  });
});
