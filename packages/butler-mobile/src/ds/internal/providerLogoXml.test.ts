// test-category: pure-logic
import { expect, test } from "bun:test";
import { providerLogoXml } from "./providerLogoXml";

test("providerLogoXml fits vendored logos and scopes gradient ids", () => {
  const openai = providerLogoXml("openai", "x");
  expect(openai).toContain('viewBox="-2.4 -2.512 28.8 28.8"');
  expect(openai).not.toContain("style=");
  expect(openai).not.toContain("1em");
  const gemini = providerLogoXml("gemini", "x");
  expect(gemini).toContain("lobe-icons-gemini-0-x");
  expect(gemini).not.toContain("_R_0_");
});
