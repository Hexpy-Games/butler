/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagementPage } from "./ManagementPage";

const css = readFileSync(new URL("./ManagementPage.module.css", import.meta.url), "utf8");

test("ManagementPage renders its content inside a PageContainer with the requested width", () => {
  const document = new JSDOM(renderToStaticMarkup(<ManagementPage width="narrow"><p>Body</p></ManagementPage>)).window.document;
  const page = document.querySelector('[data-slot="page-container"]')!;
  expect(page.getAttribute("data-width")).toBe("narrow");
  expect(page.textContent).toBe("Body");
  const defaults = new JSDOM(renderToStaticMarkup(<ManagementPage><p>Body</p></ManagementPage>)).window.document;
  expect(defaults.querySelector('[data-slot="page-container"]')!.getAttribute("data-width")).toBe("default");
});

test("the gutter belongs to PageContainer, so the scroll content has no inline padding", () => {
  const content = /(?:^|\n)\.content\s*\{([^}]*)\}/u.exec(css)![1]!;
  expect(content).toMatch(/padding-inline:\s*0/u);
  expect(content).not.toMatch(/clamp\(/u);
});
