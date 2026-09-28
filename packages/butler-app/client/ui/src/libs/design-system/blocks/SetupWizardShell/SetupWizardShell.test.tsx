/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupWizardContent, SetupWizardShell } from "./SetupWizardShell";

const css = readFileSync(new URL("./SetupWizardShell.module.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

function render(tone?: "light" | "dark") {
  return new JSDOM(renderToStaticMarkup(
    <SetupWizardShell activeIndex={0} steps={[{ id: "a", label: "Language" }]} title="Butler" tone={tone}>
      <p>Step</p>
    </SetupWizardShell>,
  )).window.document;
}

test("SetupWizardShell renders inside a narrow PageContainer and themes the backdrop", () => {
  const document = render("dark");
  const screen = document.querySelector("main")!;
  expect(screen.getAttribute("data-tone")).toBe("dark");
  expect(document.querySelector('[data-slot="page-container"]')!.getAttribute("data-width")).toBe("narrow");
  expect(render().querySelector("main")!.getAttribute("data-tone")).toBe("light");
});

test("the title shares the body's inline inset and the scroll area reaches the body bottom", () => {
  // The glass body has no padding; its scroll content carries the inset.
  expect(render().querySelector('[data-slot="tinted-glass"]')!.getAttribute("data-padding")).toBe("none");
  expect(rule(".scrollContent")).toMatch(/padding:\s*var\(--setup-wizard-inset\)/u);
  expect(rule(".header")).toMatch(/padding-inline:\s*calc\(var\(--setup-wizard-inset\) \+ var\(--border-hairline\)\)/u);
  expect(css).toMatch(/--setup-wizard-inset:\s*var\(--space-lg\)/u);
});

function renderFocus(width?: "default" | "wide") {
  return new JSDOM(renderToStaticMarkup(
    <SetupWizardShell variant="focus" title="Butler">
      <SetupWizardContent width={width}><p>Welcome</p></SetupWizardContent>
    </SetupWizardShell>,
  )).window.document;
}

test("the focus variant drops the title, stepper and glass body for one centered column", () => {
  const document = renderFocus();
  const screen = document.querySelector("main")!;
  expect(screen.getAttribute("data-variant")).toBe("focus");
  expect(document.querySelector("ol")).toBeNull();
  expect(document.querySelector('[data-slot="tinted-glass"]')).toBeNull();
  expect(document.querySelector('[data-test-class="setup-wizard-drag-lane"]')).not.toBeNull();
  expect(document.querySelector('[data-test-class="setup-wizard-scroll"]')).not.toBeNull();
  const column = document.querySelector('section[aria-label="Butler"]');
  expect(column?.textContent).toBe("Welcome");
  // The column is the DS page frame (narrow cap); content widths come from SetupWizardContent.
  expect(column?.getAttribute("data-slot")).toBe("page-container");
  expect(column?.getAttribute("data-width")).toBe("narrow");
  expect(render().querySelector("main")!.getAttribute("data-variant")).toBe("wizard");
});

test("focus content is a 420px column, 520px when wide, top-aligned below the titlebar", () => {
  expect(renderFocus("wide").querySelector('[data-width="wide"]')).not.toBeNull();
  expect(css).toMatch(/\.screen\[data-variant="focus"\] \.content\s*\{[^}]*max-width: 420px/u);
  expect(css).toMatch(/\.screen\[data-variant="focus"\] \.content\[data-width="wide"\]\s*\{[^}]*max-width: 520px/u);
  expect(rule(".focusScrollContent")).toMatch(/align-content:\s*start/u);
  expect(rule(".focusScrollContent")).toMatch(/padding-top:\s*max\(calc\(var\(--titlebar-height\) \+ var\(--space-md\)\), 10vh\)/u);
});
