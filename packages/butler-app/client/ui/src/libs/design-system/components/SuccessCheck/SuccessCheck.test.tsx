/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SuccessCheck } from "./SuccessCheck";

const css = readFileSync(new URL("./SuccessCheck.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

function svg(markup: string) {
  return new JSDOM(markup).window.document.querySelector("svg")!;
}

test("SuccessCheck draws a check (optionally in a ring) on the icon grid, decorative unless labelled", () => {
  const plain = svg(renderToStaticMarkup(<SuccessCheck size={14} />));
  expect(plain.getAttribute("data-slot")).toBe("success-check");
  expect(plain.getAttribute("width")).toBe("14");
  expect(plain.getAttribute("aria-hidden")).toBe("true");
  expect(plain.getAttribute("data-animate")).toBe("true");
  expect(plain.querySelector("circle")).toBeNull();
  expect(plain.querySelector("path")!.getAttribute("pathLength")).toBe("100");
  const ringed = svg(renderToStaticMarkup(<SuccessCheck ring animate={false} label="Done" />));
  expect(ringed.querySelector("circle")!.getAttribute("pathLength")).toBe("100");
  expect(ringed.getAttribute("data-animate")).toBe("false");
  expect(ringed.getAttribute("role")).toBe("img");
  expect(ringed.getAttribute("aria-label")).toBe("Done");
});

test("the check draws its stroke and pops in on DS motion tokens within ~320ms; reduced motion only fades", () => {
  expect(css).toContain('.check[data-animate="true"] { animation: success-check-pop var(--motion-base) var(--motion-ease-standard) both; }');
  expect(css).toContain('.check[data-animate="true"] .ring { animation: success-check-draw var(--motion-slow) var(--motion-ease-standard) both; }');
  expect(css).toContain('.check[data-animate="true"] .mark { animation: success-check-draw var(--motion-slow) var(--motion-ease-standard) var(--motion-menu) both; }');
  expect(css).toMatch(/@keyframes success-check-draw \{ from \{ stroke-dashoffset: 100; \} \}/u);
  expect(css).toMatch(/@keyframes success-check-pop \{ from \{ opacity: 0; transform: scale\(var\(--motion-scale-check\)\); \} \}/u);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.check\[data-animate="true"\] \.ring, \.check\[data-animate="true"\] \.mark \{ animation: none; \} \}/u);
  // Tokens: the pop scale is subtle and turns to 1 under both reduced-motion scopes.
  expect(tokens).toMatch(/--motion-scale-check: 0\.8\d?;/u);
  expect(tokens.match(/--motion-scale-check: 1;/gu)?.length).toBe(2);
});
