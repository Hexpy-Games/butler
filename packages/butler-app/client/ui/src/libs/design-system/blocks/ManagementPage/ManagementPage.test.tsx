/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagementPage, ManagementPagePanel } from "./ManagementPage";

const css = readFileSync(new URL("./ManagementPage.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
const dom = (markup: string) => new JSDOM(markup).window.document;
const rule = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  return start < 0 ? "" : css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
};

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

test("without a background the page stays plain and panels add no DOM", () => {
  const plain = renderToStaticMarkup(<ManagementPage><p>Head</p><p>Body</p></ManagementPage>);
  const panels = renderToStaticMarkup(
    <ManagementPage><ManagementPagePanel><p>Head</p></ManagementPagePanel><ManagementPagePanel><p>Body</p></ManagementPagePanel></ManagementPage>,
  );
  expect(panels).toBe(plain);
  expect(dom(plain).querySelector('[data-slot="management-page-background"]')).toBeNull();
});

test("a background sits behind the scroll content, decorative, with the calm treatment by default", () => {
  const document = dom(renderToStaticMarkup(
    <ManagementPage background={<canvas data-test-class="bg-probe" />}><p>Body</p></ManagementPage>,
  ));
  const page = document.body.firstElementChild!;
  const layer = page.firstElementChild!;
  expect(layer.getAttribute("data-slot")).toBe("management-page-background");
  expect(layer.getAttribute("aria-hidden")).toBe("true");
  expect(layer.getAttribute("data-treatment")).toBe("calm");
  expect(layer.querySelector('[data-test-class="bg-probe"]')).not.toBeNull();
  expect(layer.nextElementSibling!.querySelector('[data-slot="page-container"]')!.textContent).toBe("Body");
  const bare = dom(renderToStaticMarkup(
    <ManagementPage background={<canvas />} backgroundTreatment="none"><p>Body</p></ManagementPage>,
  ));
  expect(bare.querySelector('[data-slot="management-page-background"]')!.getAttribute("data-treatment")).toBe("none");
});

test("over a background, panels become TintedGlass surfaces that keep their content", () => {
  const document = dom(renderToStaticMarkup(
    <ManagementPage background={<canvas />}>
      <ManagementPagePanel><p>Head</p></ManagementPagePanel>
      <ManagementPagePanel><p>Body</p></ManagementPagePanel>
    </ManagementPage>,
  ));
  const panels = [...document.querySelectorAll('[data-slot="management-page-panel"]')];
  expect(panels.map((panel) => panel.textContent)).toEqual(["Head", "Body"]);
  // CSS modules are stubbed in unit tests, so the surface class is checked at its source.
  expect(readFileSync(new URL("./ManagementPage.tsx", import.meta.url), "utf8"))
    .toContain('className={cn(tintedGlassSurfaceClassName, styles.panel)} data-slot="management-page-panel"');
});

test("the background layer fills the page without taking input, and calm is a tokenized veil", () => {
  const layer = rule(".background");
  expect(layer).toMatch(/position:\s*absolute/u);
  expect(layer).toMatch(/inset:\s*0/u);
  expect(layer).toMatch(/pointer-events:\s*none/u);
  expect(rule('.background[data-treatment="calm"]::after')).toMatch(/background:\s*var\(--management-page-veil\)/u);
  expect(css).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/iu);
  for (const scope of [":root", ".theme-dark", ".theme-light"]) {
    const body = new RegExp(`(?:^|\\n)${scope.replace(".", "\\.")}\\s*\\{([^]*?)\\n\\}`, "u").exec(tokens)?.[1] ?? "";
    expect({ scope, veil: /--management-page-veil:/u.test(body) }).toEqual({ scope, veil: true });
  }
});
