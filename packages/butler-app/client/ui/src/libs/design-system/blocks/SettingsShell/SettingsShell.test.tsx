/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsShell } from "./SettingsShell";

const css = readFileSync(new URL("./SettingsShell.module.css", import.meta.url), "utf8");

test("the settings header and detail content sit in start-aligned narrow PageContainers", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <SettingsShell sidebar={<nav />} detailHeader={<h2>General</h2>} detail={<section>Fields</section>} />,
  )).window.document;
  const pages = [...document.querySelectorAll('[data-slot="page-container"]')];
  expect(pages).toHaveLength(2);
  for (const page of pages) {
    expect(page.getAttribute("data-width")).toBe("narrow");
    expect(page.getAttribute("data-align")).toBe("start");
    expect(page.getAttribute("data-gutter")).toBe("none");
  }
  expect(pages[0]!.textContent).toBe("General");
  expect(pages[1]!.textContent).toBe("Fields");
  expect(pages[1]!.closest('[data-test-class="settings-detail-scroll"]')).not.toBeNull();
});

test("SettingsShell owns no page max-width of its own", () => {
  expect(css).not.toMatch(/max-width:\s*760px/u);
});
