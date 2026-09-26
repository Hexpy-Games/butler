/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SplitButton } from "./SplitButton";

const css = readFileSync(new URL("./SplitButton.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");
const noop = () => undefined;

function render(markup: string) {
  return new JSDOM(markup).window.document;
}

test("the action and the menu trigger are two buttons in one labelled group", () => {
  const doc = render(renderToStaticMarkup(
    <SplitButton text="Allow once" onClick={noop} menuLabel="More allow options"
      items={[{ key: "conversation", label: "Allow for this conversation", onSelect: noop }]} />,
  ));
  const group = doc.querySelector('[data-slot="split-button"]')!;
  expect(group.getAttribute("role")).toBe("group");
  const buttons = group.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0]!.textContent).toBe("Allow once");
  expect(buttons[0]!.getAttribute("data-variant")).toBe("default");
  expect(buttons[1]!.getAttribute("aria-label")).toBe("More allow options");
  expect(buttons[1]!.getAttribute("aria-haspopup")).toBe("menu");
});

test("variant, size and disabled reach both halves; the arrow disables when no item can run", () => {
  const doc = render(renderToStaticMarkup(
    <SplitButton text="Run" onClick={noop} menuLabel="Run options" variant="outline" size="sm"
      items={[{ key: "later", label: "Run later", onSelect: noop, disabled: true }]} />,
  ));
  const [action, arrow] = [...doc.querySelectorAll("button")];
  expect(action!.getAttribute("data-variant")).toBe("outline");
  expect(action!.getAttribute("data-size")).toBe("sm");
  expect(action!.hasAttribute("disabled")).toBe(false);
  expect(arrow!.hasAttribute("disabled")).toBe(true);

  const disabled = render(renderToStaticMarkup(
    <SplitButton text="Run" onClick={noop} menuLabel="Run options" disabled
      items={[{ key: "later", label: "Run later", onSelect: noop }]} />,
  ));
  expect([...disabled.querySelectorAll("button")].every((button) => button.hasAttribute("disabled"))).toBe(true);
});

test("the halves join with square inner corners and one shared seam", () => {
  expect(css).toMatch(/\.split > \.action \{[^}]*border-start-end-radius: 0;[^}]*border-end-end-radius: 0;/u);
  expect(css).toMatch(/\.split > \.arrow \{[^}]*border-start-start-radius: 0;[^}]*border-end-start-radius: 0;/u);
  expect(css).toMatch(/\.split > \.arrow \{[^}]*min-inline-size: var\(--control-hit-target\)/u);
});
