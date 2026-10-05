// Package the canonical DS values/idle mark without loading React or the app.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokens = readFileSync(new URL("../../ui/src/libs/design-system/tokens.css", import.meta.url), "utf8");
const declarations = new Map([...tokens.split("\n}")[0].matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((match) => [match[1], match[2]]));
const selected = new Map();
function publish(name, content) {
  const target = new URL(`../assets/${name}`, import.meta.url);
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== content) throw new Error(`Stale DS asset: ${name}`);
  } else writeFileSync(target, content);
}
function include(name) {
  if (selected.has(name)) return;
  const value = declarations.get(name);
  if (!value) throw new Error(`DS token missing: ${name}`);
  selected.set(name, value);
  for (const match of value.matchAll(/var\((--[\w-]+)/gu)) include(match[1]);
}
for (const name of [
  "--font-body", "--space-none", "--space-md", "--space-lg", "--space-2xl", "--space-4xl",
  "--icon-size-2xl", "--typo-body-size", "--typo-body-weight", "--typo-body-line-height",
  "--typo-app-title-size", "--typo-app-title-weight", "--typo-app-title-line-height",
  "--color-surface-base", "--text-primary", "--text-secondary",
]) include(name);
const css = `/* Generated from UI DS tokens.css by scripts/sync-lifecycle-assets.mjs. */\n:root {\n${[...selected].map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}\n`;
publish("lifecycle-tokens.css", css);

// The Site DS exposes its filled idle mark as a static SVG. Preserve its exact
// geometry; only JSX attributes and the React-specific class are removed.
const mark = readFileSync(new URL("../../../../butler-site/src/ds/components/ButlerThinkingMark/ButlerMarkLogo.tsx", import.meta.url), "utf8");
const svg = mark.match(/<svg[\s\S]*?<\/svg>/u)?.[0]
  .replace(/ className=\{[^}]+\}/u, "")
  .replace(/=\{(\d+)\}/gu, '="$1"')
  .replaceAll("strokeLinejoin", "stroke-linejoin")
  .replaceAll("strokeWidth", "stroke-width")
  .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="currentColor" ');
if (!svg) throw new Error("DS idle mark missing");
publish("lifecycle-mark.svg", `${svg}\n`);
console.log(`DS lifecycle assets synchronized: ${fileURLToPath(new URL("../assets", import.meta.url))}`);
