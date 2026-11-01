// test-category: format-pin
/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { PROVIDER_LOGO_NAMES } from "./ProviderLogo";
import { PROVIDER_LOGO_SVGS, VENDORED_VIEWBOX } from "./providerLogoSvgs";

const logosDir = new URL("./logos/", import.meta.url);
test("each logo string is a byte-for-byte copy of its vendored SVG file", () => {
  for (const [name, logo] of Object.entries(PROVIDER_LOGO_SVGS)) {
    expect({ name, svg: logo.svg }).toEqual({ name, svg: readFileSync(new URL(logo.file, logosDir), "utf8") });
    expect({ name, framed: logo.svg.includes(VENDORED_VIEWBOX), fit: /^-?[\d.]+ -?[\d.]+ ([\d.]+) \1$/u.test(logo.fit) }).toEqual({ name, framed: true, fit: true });
  }
});

test("only the twelve listed logos are vendored, and the NOTICE names every file", () => {
  const files = readdirSync(logosDir).filter((file) => file.endsWith(".svg")).sort();
  expect(files).toEqual([...new Set(Object.values(PROVIDER_LOGO_SVGS).map((logo) => logo.file))].sort());
  const notice = readFileSync(new URL("NOTICE", logosDir), "utf8");
  expect(notice).toContain("@lobehub/icons-static-svg, version 1.95.1");
  expect(notice).toContain("MIT License");
  expect(notice).toContain("trademarks of their respective owners");
  for (const file of files) expect(notice).toContain(file);
  expect(PROVIDER_LOGO_NAMES).toEqual(Object.keys(PROVIDER_LOGO_SVGS) as typeof PROVIDER_LOGO_NAMES);
});

test("only the Claude name carries the Claude mark's optical correction; Anthropic uses the centred fit", () => {
  expect(PROVIDER_LOGO_SVGS.claude.fit).toBe("-2.4 -4.457 28.8 28.8");
  expect(PROVIDER_LOGO_SVGS.anthropic).toEqual({ ...PROVIDER_LOGO_SVGS.claude, fit: "-2.4 -2.4 28.8 28.8" });
});
