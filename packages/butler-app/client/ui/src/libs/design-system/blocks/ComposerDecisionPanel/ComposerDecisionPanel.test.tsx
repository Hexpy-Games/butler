/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerDecisionPanel } from "./ComposerDecisionPanel";

const css = readFileSync(new URL("./ComposerDecisionPanel.module.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

function render(error?: string, details?: readonly string[]) {
  return new JSDOM(renderToStaticMarkup(
    <ComposerDecisionPanel data-test-class="decision" icon={<svg data-icon="shield" />} title="Allow writing outside the workspace"
      onOpen={() => undefined} error={error} details={details} aside={<span data-aside="count">+2</span>}
      actions={<><button type="button">Deny</button><button type="button">Allow</button></>} />,
  )).window.document;
}

test("ComposerDecisionPanel lists details under the title as one-line secondary captions", () => {
  const panel = render(undefined, ["a.png", "b.png", "+22 more"]).querySelector('[data-test-class="decision"]')!;
  const [subject, details, actions] = [...panel.children];
  expect(subject!.getAttribute("data-has-details")).toBe("true");
  expect(details!.getAttribute("data-slot")).toBe("composer-decision-details");
  const lines = [...details!.children];
  expect(lines.map((line) => line.textContent)).toEqual(["a.png", "b.png", "+22 more"]);
  expect(lines.every((line) => line.getAttribute("data-tone") === "secondary" && line.getAttribute("data-truncate") === "true"))
    .toBe(true);
  expect(actions!.getAttribute("data-slot")).toBe("composer-decision-actions");
  // No details: no empty row and the subject keeps its full padding.
  const plain = render(undefined, []).querySelector('[data-test-class="decision"]')!;
  expect(plain.querySelector('[data-slot="composer-decision-details"]')).toBeNull();
  expect(plain.children[0]!.getAttribute("data-has-details")).toBeNull();
});

test("ComposerDecisionPanel keeps the aside at its own width so a status Tag never shrinks under the count", () => {
  const subject = render().querySelector('[data-slot="composer-decision-subject"]')!;
  expect(subject.querySelector('[data-slot="composer-decision-aside"] [data-aside="count"]')).not.toBeNull();
  expect(rule(".aside")).toMatch(/flex:\s*none/u);
  expect(rule(".aside")).toMatch(/gap:\s*var\(--space-sm\)/u);
});

test("ComposerDecisionPanel indents details to the title and keeps them tight under it", () => {
  expect(rule(".details")).toMatch(/padding-inline-start:\s*calc\(\s*var\(--space-lg\) \+ var\(--icon-size-lg\) \+ var\(--space-sm\)\s*\)/u);
  expect(rule('.subject[data-has-details="true"]')).toMatch(/padding-block-end:\s*var\(--space-xs\)/u);
});

test("ComposerDecisionPanel puts the icon, the clickable title and the aside on one subject row above the actions", () => {
  const document = render();
  const panel = document.querySelector('[data-test-class="decision"]')!;
  const [subject, actions] = [...panel.children];
  expect(subject!.getAttribute("data-slot")).toBe("composer-decision-subject");
  expect(subject!.querySelector('[data-icon="shield"]')).not.toBeNull();
  expect(subject!.querySelector("[title]")?.getAttribute("title")).toBe("Allow writing outside the workspace");
  expect(subject!.querySelector('[data-aside="count"]')).not.toBeNull();
  expect(actions!.getAttribute("data-slot")).toBe("composer-decision-actions");
  expect(actions!.querySelectorAll("button")).toHaveLength(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.innerHTML).not.toContain("style=");
});

test("ComposerDecisionPanel shows an error between the subject and the actions as an alert", () => {
  const panel = render("Could not send the decision.").querySelector('[data-test-class="decision"]')!;
  expect(panel.children).toHaveLength(3);
  expect(panel.children[1]!.querySelector('[role="alert"]')?.textContent).toBe("Could not send the decision.");
});

test("ComposerDecisionPanel owns the icon tone and the composer-radius action buttons", () => {
  expect(rule(".subject > svg")).toMatch(/color:\s*var\(--text-secondary\)/u);
  expect(rule(".actions button")).toMatch(/border-radius:\s*var\(--adaptive-composer-radius\)/u);
  expect(rule(".subject")).toMatch(/padding:\s*var\(--space-md\) var\(--space-lg\)/u);
});
