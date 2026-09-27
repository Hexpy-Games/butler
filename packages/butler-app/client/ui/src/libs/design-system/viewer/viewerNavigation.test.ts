/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import type { ShowcaseCategory } from "../showcase/categories";
import { filterEntries, groupEntries, resolveViewerPage } from "./viewerNavigation";

function entry(id: string, category: ShowcaseCategory, tags: string[] = []): ShowcaseEntry {
  const name = id.split("/")[1];
  return {
    id,
    name,
    kind: id.startsWith("components/") ? "component" : "block",
    sourcePath: `libs/design-system/${id}`,
    meta: { title: name, category, tags },
    stories: [],
    stateMatrix: null,
    guidance: null,
    loadGuidanceSource: null,
    readme: null,
  };
}

const entries = [
  entry("components/Button", "Action", ["control", "borderless"]),
  entry("components/Input", "Input", ["form"]),
  entry("components/Stack", "Layout", ["responsive"]),
  entry("blocks/NavRow", "Navigation", ["sidebar", "row"]),
  entry("blocks/ComposerCard", "Composer", ["chat", "glass"]),
];

describe("DS Viewer navigation", () => {
  test("resolves fixed sections, galleries, token pages and patterns", () => {
    expect(resolveViewerPage("overview", entries)).toEqual({ kind: "overview" });
    expect(resolveViewerPage("guide", entries)).toEqual({ kind: "guide" });
    expect(resolveViewerPage("recipes", entries)).toEqual({ kind: "recipes" });
    expect(resolveViewerPage("foundations", entries)).toEqual({ kind: "foundations" });
    expect(resolveViewerPage("foundations/color", entries)).toEqual({ kind: "tokens", category: "color" });
    expect(resolveViewerPage("foundations/nope", entries)).toEqual({ kind: "not-found", id: "foundations/nope" });
    expect(resolveViewerPage("motion", entries)).toEqual({ kind: "motion" });
    expect(resolveViewerPage("components", entries)).toEqual({ kind: "gallery", section: "components" });
    expect(resolveViewerPage("blocks", entries)).toEqual({ kind: "gallery", section: "blocks" });
    expect(resolveViewerPage("patterns", entries)).toEqual({ kind: "patterns" });
    expect(resolveViewerPage("patterns/tinted-glass", entries, ["tinted-glass"])).toEqual({ kind: "pattern", id: "tinted-glass" });
    expect(resolveViewerPage("icons", entries)).toEqual({ kind: "icons" });
  });

  test("resolves item pages by folder id or by bare name, case-insensitively", () => {
    expect(resolveViewerPage("components/Button", entries)).toEqual({ kind: "item", entry: entries[0] });
    expect(resolveViewerPage("navrow", entries)).toEqual({ kind: "item", entry: entries[3] });
    expect(resolveViewerPage("components/Missing", entries)).toEqual({ kind: "not-found", id: "components/Missing" });
  });

  test("groups entries in sidebar category order and skips empty groups", () => {
    expect(groupEntries(entries, "component").map((group) => [group.category, group.entries.map((item) => item.name)]))
      .toEqual([["Action", ["Button"]], ["Input", ["Input"]], ["Layout", ["Stack"]]]);
    expect(groupEntries(entries, "block").map((group) => group.category)).toEqual(["Navigation", "Composer"]);
  });

  test("search matches name, tags, and category; every term must match", () => {
    const names = (query: string) => filterEntries(entries, query).map((item) => item.name);

    expect(names("")).toEqual(entries.map((item) => item.name));
    expect(names("button")).toEqual(["Button"]);
    expect(names("sidebar")).toEqual(["NavRow"]);
    expect(names("composer")).toEqual(["ComposerCard"]);
    expect(names("layout")).toEqual(["Stack"]);
    expect(names("glass chat")).toEqual(["ComposerCard"]);
    expect(names("glass form")).toEqual([]);
  });
});
