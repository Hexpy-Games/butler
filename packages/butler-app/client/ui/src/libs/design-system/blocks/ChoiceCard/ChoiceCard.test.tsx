/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Monitor } from "../../components/Icons";
import { Tag } from "../../components/Tag";
import { ChoiceCard, ChoiceCardList, ChoiceTile, ChoiceTileGrid } from "./ChoiceCard";

const css = readFileSync(new URL("./ChoiceCard.module.css", import.meta.url), "utf8");

function doc(markup: string) {
  return new JSDOM(markup).window.document;
}

/** Every top-level declaration block whose selector list includes `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]"=]/gu, "\\$&");
  const blocks = [...css.matchAll(new RegExp(`(?:^|\\n)(?:[^{}\\n]+,\\n)*${escaped}(?:,\\n[^{}]+)? \\{([^}]*)\\}`, "gu"))].map((match) => match[1]!);
  expect({ selector, found: blocks.length > 0 }).toEqual({ selector, found: true });
  return blocks.join("\n");
}

afterEach(() => {
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"]) delete (globalThis as Record<string, unknown>)[key];
});

test("a ChoiceCard is a button with its description wired to aria-describedby", () => {
  const page = doc(renderToStaticMarkup(
    <ChoiceCard icon={<Monitor />} title="ChatGPT" tag={<Tag tone="accent">No key needed</Tag>} description="Sign in with ChatGPT" />,
  ));
  const button = page.querySelector("button")!;
  expect(button.getAttribute("type")).toBe("button");
  expect(button.getAttribute("data-slot")).toBe("choice-card");
  const described = button.getAttribute("aria-describedby")!;
  expect(page.getElementById(described)?.textContent).toBe("Sign in with ChatGPT");
  expect(button.textContent).toContain("No key needed");
  expect(button.querySelector('[data-slot="icon-tile"]')).not.toBeNull();
});

test("loading, error and disabled states are exposed to assistive tech and swap the trailing glyph", () => {
  const loading = doc(renderToStaticMarkup(<ChoiceCard icon={<Monitor />} title="Claude" state="loading" />)).querySelector("button")!;
  expect(loading.getAttribute("aria-busy")).toBe("true");
  expect(loading.querySelector('[data-slot="spinner"], svg[role="status"], [data-spinner]')).not.toBeNull();
  const disabled = doc(renderToStaticMarkup(<ChoiceCard icon={<Monitor />} title="Claude" state="disabled" />)).querySelector("button")!;
  expect(disabled.getAttribute("aria-disabled")).toBe("true");
  const error = doc(renderToStaticMarkup(<ChoiceCard icon={<Monitor />} title="Claude" state="error" />)).querySelector("button")!;
  expect(error.getAttribute("data-state")).toBe("error");
  const selected = doc(renderToStaticMarkup(<ChoiceCard icon={<Monitor />} title="qwen3:8b" selected role="radio" aria-checked chevron={false} meta="5.2 GB" />)).querySelector("button")!;
  expect(selected.getAttribute("data-selected")).toBe("true");
  expect(selected.getAttribute("role")).toBe("radio");
  expect(selected.textContent).toContain("5.2 GB");
});

test("a disabled or loading card ignores clicks", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const clicks: string[] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(
    <ChoiceCardList>
      <ChoiceCard icon={<Monitor />} title="Off" state="disabled" onClick={() => clicks.push("off")} />
      <ChoiceCard icon={<Monitor />} title="Busy" state="loading" onClick={() => clicks.push("busy")} />
      <ChoiceCard icon={<Monitor />} title="On" onClick={() => clicks.push("on")} />
    </ChoiceCardList>,
  ));
  for (const button of Array.from(dom.window.document.querySelectorAll("button"))) {
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  }
  expect(clicks).toEqual(["on"]);
  expect(dom.window.document.querySelectorAll("ul > li > button")).toHaveLength(3);
  await act(async () => root.unmount());
});

test("tiles sit in an equal-size grid: fixed rows, 1fr auto rows, two then three columns", () => {
  const page = doc(renderToStaticMarkup(
    <ChoiceTileGrid id="more">
      <ChoiceTile icon={<Monitor />} title="Z.AI Coding Plan" description="Coding Plan key" />
      <ChoiceTile icon={<Monitor />} title="Other (OpenAI-compatible)" description="Your own server" />
      <ChoiceTile icon={<Monitor />} title="This computer" description="Ollama or LM Studio off" placeholder />
    </ChoiceTileGrid>,
  ));
  const grid = page.querySelector('[data-slot="choice-tile-grid"]')!;
  expect(grid.tagName).toBe("UL");
  expect(grid.id).toBe("more");
  const tiles = Array.from(grid.querySelectorAll(":scope > li > button"));
  expect(tiles).toHaveLength(3);
  for (const tile of tiles) {
    expect(tile.querySelector('[data-slot="choice-tile-title"]')?.getAttribute("data-line-clamp")).toBe("2");
    expect(tile.querySelector('[data-slot="choice-tile-description"]')?.getAttribute("data-truncate")).toBe("true");
  }
  expect(tiles[2]!.getAttribute("data-placeholder")).toBe("true");
  expect(rule(".grid")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(rule(".grid")).toContain("grid-auto-rows: 1fr");
  expect(css).toMatch(/@container choice-tile-grid \(width >= 480px\)\s*\{\s*\.grid\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
  // The name keeps a fixed two-line box so one- and two-line names give the same tile height.
  expect(rule(".tileTitle")).toContain("height: calc(var(--typo-label-size) * var(--typo-label-line-height) * 2)");
  expect(rule(".tile")).toContain("height: 100%");
});

test("a narrow tile stacks the logo above the name so long names get the full width", () => {
  expect(css).toMatch(/@container choice-tile \(width < 160px\)/u);
  expect(css).toMatch(/@media \(width <= 640px\) \{\s*@container choice-tile \(width < 185px\)/u);
  expect(rule(".gridItem")).toContain("container: choice-tile / inline-size");
});
