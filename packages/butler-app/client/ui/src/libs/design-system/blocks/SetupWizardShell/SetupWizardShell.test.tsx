/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupWizardShell } from "./SetupWizardShell";

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
