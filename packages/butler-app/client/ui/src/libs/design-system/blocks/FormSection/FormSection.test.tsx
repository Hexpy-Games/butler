/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { FormSection } from "./FormSection";

function render(node: React.ReactNode) {
  const document = new JSDOM(renderToStaticMarkup(<>{node}</>)).window.document;
  const section = document.querySelector('[data-slot="form-section"]')!;
  return {
    section,
    header: section.querySelector(':scope > [data-slot="form-section-header"]'),
    card: section.querySelector(':scope > [data-slot="form-section-card"]'),
  };
}

test("the section header sits above the card, outside it, and the card holds only fields", () => {
  const { section, header, card } = render(
    <FormSection title="Search" description="Configure web search providers.">
      <div data-testid="field">Provider</div>
    </FormSection>,
  );
  expect(section.tagName).toBe("SECTION");
  expect(header?.querySelector("h3")?.textContent).toBe("Search");
  expect(header?.querySelector("p")?.textContent).toBe("Configure web search providers.");
  expect(header?.nextElementSibling).toBe(card);
  expect(card?.querySelector("h3, p")).toBeNull();
  expect(card?.children).toHaveLength(1);
  expect(section.getAttribute("aria-labelledby")).toBe(header?.querySelector("h3")?.id ?? "missing");
});

test("a title-only section renders the header without a description", () => {
  const { header, card } = render(
    <FormSection title="Model settings"><div>Model</div></FormSection>,
  );
  expect(header?.querySelector("h3")?.textContent).toBe("Model settings");
  expect(header?.querySelector("p")).toBeNull();
  expect(card).not.toBeNull();
});

test("a section without a title (its page title names it) renders only the card", () => {
  const { section, header, card } = render(
    <FormSection><div>Theme</div></FormSection>,
  );
  expect(header).toBeNull();
  expect(section.hasAttribute("aria-labelledby")).toBe(false);
  expect(card?.textContent).toBe("Theme");
});

test("a description without a title still sits above the card", () => {
  const { header, card } = render(
    <FormSection description="Review model tokens and tool calls."><div>Usage</div></FormSection>,
  );
  expect(header?.querySelector("h3")).toBeNull();
  expect(header?.querySelector("p")?.textContent).toBe("Review model tokens and tool calls.");
  expect(header?.nextElementSibling).toBe(card);
});
