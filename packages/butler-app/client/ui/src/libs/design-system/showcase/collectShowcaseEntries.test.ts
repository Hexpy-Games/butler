/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { collectShowcaseEntries } from "./collectShowcaseEntries";
import type { ShowcaseModule } from "./types";

const buttonShowcase: ShowcaseModule = {
  meta: { title: "Button", category: "Action", tags: ["action"], status: "stable" },
  stories: [{ name: "Variants", render: () => "button" }],
};

const registryButton: ShowcaseModule = {
  meta: { title: "Button", category: "Action", tags: ["legacy"] },
  stories: [{ name: "Default", render: () => "legacy button" }],
};

const registryNavRow: ShowcaseModule = {
  meta: { title: "NavRow", category: "Navigation", tags: ["navigation"] },
  stories: [{ name: "Default", render: () => "nav row" }],
};

function collect() {
  return collectShowcaseEntries({
    showcaseModules: { "../components/Button/Button.showcase.tsx": buttonShowcase },
    readmeModules: {
      "../components/Button/README.md": "# Button",
      "../blocks/NavRow/README.md": "# NavRow",
    },
    fallbacks: { "components/Button": registryButton, "blocks/NavRow": registryNavRow },
    legacyCategories: { "components/Toast": "Overlay", "blocks/NavRow": "Navigation" },
  });
}

describe("collectShowcaseEntries", () => {
  test("lists every component and block folder once, components first", () => {
    expect(collect().map((entry) => entry.id)).toEqual([
      "components/Button",
      "components/Toast",
      "blocks/NavRow",
    ]);
  });

  test("prefers a co-located showcase file over the temporary registry adapter", () => {
    const button = collect().find((entry) => entry.id === "components/Button");

    expect(button?.origin).toBe("showcase");
    expect(button?.stories.map((story) => story.name)).toEqual(["Variants"]);
    expect(button?.meta.status).toBe("stable");
  });

  test("keeps registry fixtures visible until the item has a showcase file", () => {
    const navRow = collect().find((entry) => entry.id === "blocks/NavRow");

    expect(navRow?.origin).toBe("registry");
    expect(navRow?.kind).toBe("block");
    expect(navRow?.meta.category).toBe("Navigation");
    expect(navRow?.stories.map((story) => story.name)).toEqual(["Default"]);
  });

  test("still lists folders without any fixture, using the legacy category map", () => {
    const toast = collect().find((entry) => entry.id === "components/Toast");

    expect(toast?.origin).toBe("none");
    expect(toast?.stories).toEqual([]);
    expect(toast?.meta).toEqual({ title: "Toast", category: "Overlay" });
    expect(toast?.readme).toBeNull();
  });

  test("attaches the folder README, source path, and public import name", () => {
    const button = collect().find((entry) => entry.id === "components/Button");

    expect(button?.name).toBe("Button");
    expect(button?.readme).toBe("# Button");
    expect(button?.sourcePath).toBe("packages/butler-app/client/ui/src/libs/design-system/components/Button");
  });
});
