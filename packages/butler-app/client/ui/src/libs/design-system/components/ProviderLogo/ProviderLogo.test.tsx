// test-category: format-pin
/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderLogo, PROVIDER_LOGO_NAMES } from "./ProviderLogo";
import { PROVIDER_LOGO_SVGS } from "./providerLogoSvgs";

const logosDir = new URL("./logos/", import.meta.url);
const css = readFileSync(new URL("./ProviderLogo.module.css", import.meta.url), "utf8");

function body(markup: string) {
  return new JSDOM(markup).window.document.body;
}

test("each logo string is a byte-for-byte copy of its vendored SVG file", () => {
  for (const [name, logo] of Object.entries(PROVIDER_LOGO_SVGS)) {
    expect({ name, svg: logo.svg }).toEqual({ name, svg: readFileSync(new URL(logo.file, logosDir), "utf8") });
  }
});

test("only the ten listed logos are vendored, and the NOTICE names every file", () => {
  const files = readdirSync(logosDir).filter((file) => file.endsWith(".svg")).sort();
  expect(files).toEqual(Object.values(PROVIDER_LOGO_SVGS).map((logo) => logo.file).sort());
  const notice = readFileSync(new URL("NOTICE", logosDir), "utf8");
  expect(notice).toContain("@lobehub/icons-static-svg, version 1.95.1");
  expect(notice).toContain("MIT License");
  expect(notice).toContain("trademarks of their respective owners");
  for (const file of files) expect(notice).toContain(file);
  expect(PROVIDER_LOGO_NAMES).toEqual(Object.keys(PROVIDER_LOGO_SVGS) as typeof PROVIDER_LOGO_NAMES);
});

test("monochrome logos paint with currentColor so they follow the text color in both themes", () => {
  for (const [name, logo] of Object.entries(PROVIDER_LOGO_SVGS)) {
    if (logo.tone !== "mono") continue;
    expect({ name, currentColor: logo.svg.startsWith('<svg fill="currentColor"') }).toEqual({ name, currentColor: true });
    expect({ name, fixedFill: /fill="#/u.test(logo.svg) }).toEqual({ name, fixedFill: false });
  }
  expect(Object.entries(PROVIDER_LOGO_SVGS).filter(([, logo]) => logo.tone === "color").map(([name]) => name))
    .toEqual(["claude", "gemini", "qwen"]);
  const base = css.slice(css.indexOf(".logo {"), css.indexOf("}", css.indexOf(".logo {")));
  expect(base).toContain("color: var(--text-primary)");
});

test("a decorative logo is hidden from assistive tech; a labelled one is an image", () => {
  const hidden = body(renderToStaticMarkup(<ProviderLogo name="openai" />)).firstElementChild!;
  expect(hidden.getAttribute("aria-hidden")).toBe("true");
  expect(hidden.getAttribute("data-slot")).toBe("provider-logo");
  expect(hidden.getAttribute("data-tone")).toBe("mono");
  expect(hidden.querySelector("svg")).not.toBeNull();
  const labelled = body(renderToStaticMarkup(<ProviderLogo name="claude" label="Claude" size="lg" />)).firstElementChild!;
  expect(labelled.getAttribute("role")).toBe("img");
  expect(labelled.getAttribute("aria-label")).toBe("Claude");
  expect(labelled.getAttribute("aria-hidden")).toBeNull();
  expect(labelled.getAttribute("data-size")).toBe("lg");
  expect(labelled.getAttribute("data-tone")).toBe("color");
});

test("gradient ids are unique per rendered logo and every url() points at its own ids", () => {
  const doc = body(renderToStaticMarkup(<><ProviderLogo name="gemini" /><ProviderLogo name="gemini" /><ProviderLogo name="qwen" /></>));
  const ids = Array.from(doc.querySelectorAll("[id]")).map((node) => node.id);
  expect(ids.length).toBeGreaterThan(3);
  expect(new Set(ids).size).toBe(ids.length);
  for (const logo of Array.from(doc.querySelectorAll('[data-slot="provider-logo"]'))) {
    const own = new Set(Array.from(logo.querySelectorAll("[id]")).map((node) => node.id));
    const refs = [...logo.innerHTML.matchAll(/url\(#([^)]+)\)/gu)].map((match) => match[1]!);
    for (const ref of refs) expect(own.has(ref)).toBe(true);
  }
});
