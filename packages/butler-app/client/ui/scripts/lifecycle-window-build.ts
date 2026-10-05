import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import subsetFont from "subset-font";
import { lifecycleBrowser, uiRoot } from "./lifecycle-browser";
import { captureLifecycleCss } from "./lifecycle-css";
import { lifecycleCopy } from "../../../../butler-i18n/src/lifecycle";

export const lifecycleOutput = resolve(uiRoot, "lifecycle-assets");
const font = resolve(uiRoot, "node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2");
function inputHashes() {
  const directories = ["src/libs/design-system", "src/components/lifecycle", "scripts"];
  const files = directories.flatMap((directory) => readdirSync(resolve(uiRoot, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(css|ts|tsx)$/.test(entry.name) && !/\.(test|showcase|guidance)\./.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))).filter((path) => !path.includes("/generated/"));
  files.push(font, resolve(uiRoot, "../../../../packages/butler-i18n/src/lifecycle.ts"));
  return Object.fromEntries(files.sort((a, b) => relative(uiRoot, a).replaceAll("\\", "/").localeCompare(relative(uiRoot, b).replaceAll("\\", "/"), "en")).map((file) => [relative(uiRoot, file).replaceAll("\\", "/"), createHash("sha256").update(readFileSync(file)).digest("hex")]));
}
export function checkLifecycleAssets() {
  const recorded = JSON.parse(readFileSync(join(lifecycleOutput, "manifest.json"), "utf8"));
  if (JSON.stringify(recorded.inputs) !== JSON.stringify(inputHashes())) throw new Error("Lifecycle window is stale. Run bun run packages/butler-app/client/ui/scripts/lifecycle-window-build.ts.");
}
async function subsetLifecycleFont() {
  const glyphs = JSON.stringify(lifecycleCopy) + "0123456789.,!?…−— ()'";
  const options = { targetFormat: "woff2" as const, noHinting: true };
  return await subsetFont(readFileSync(font), glyphs, options);
}
async function capture() {
  const host = await lifecycleBrowser();
  try {
    const page = await host.browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(host.url);
    await page.locator("[data-slot=primary]").waitFor();
    const css = await page.evaluate(captureLifecycleCss, (await page.locator("#root > *").elementHandle())!);
    return await page.evaluate((css) => {
      const root = document.querySelector("#root > *")!.cloneNode(true) as Element;
      const primary = root.querySelector("[data-slot=primary]")!;
      const destructive = root.querySelector("[data-slot=destructive]")!;
      const mark = root.querySelector('[data-test-class="lifecycle-mark"] canvas')!;
      mark.setAttribute("data-slot", "mark");
      const wallpaper = root.querySelector("canvas:not([data-slot=mark])");
      const classes: Record<string, string> = { primary: primary.className, destructive: destructive.className, backdrop: wallpaper?.className ?? "" };
      const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
      for (const name of ["outgoing", "incoming"]) {
        const rule = rules.find((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(`_${name}_`)) as CSSStyleRule | undefined;
        classes[name] = `${root.querySelector('[data-motion="current"]')!.className} ${rule?.selectorText.slice(1) ?? ""}`;
      }
      destructive.remove();
      root.querySelectorAll("canvas:not([data-slot=mark])").forEach((canvas) => canvas.remove());
      const base = document.querySelector("html")!;
      return { html: root.outerHTML, css, classes,
        surfaceBase: { light: getComputedStyle(base).getPropertyValue("--color-surface-base").trim(), dark: "" } };
    }, css);
  } finally { await host.close(); }
}
async function bundled(entry: string) {
  const build = await Bun.build({ entrypoints: [resolve(uiRoot, entry)], target: "browser", format: "iife", minify: true });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return await build.outputs[0]!.text();
}
export async function buildLifecycleAssets(check = false) {
  const [view, fontBytes, mark, state] = await Promise.all([capture(), subsetLifecycleFont(),
    bundled("src/components/lifecycle/mark-entry.ts"), bundled("src/components/lifecycle/state.ts")]);
  const tokens = readFileSync(resolve(uiRoot, "src/libs/design-system/tokens.css"), "utf8");
  const colors = Object.fromEntries([...tokens.matchAll(/(--grayscale-\d+):\s*(#[\da-f]+);/g)].map((match) => [match[1]!, match[2]!]));
  const surface = [...tokens.matchAll(/--color-surface-base:\s*var\((--[\w-]+)\)/g)].map((match) => colors[match[1]!]);
  const manifest = { inputs: inputHashes(), surfaceBase: { light: surface[0], dark: surface[1] } };
  const css = `${view.css}[hidden]{display:none!important}`;
  const prefix = `<!doctype html><html data-classes='${JSON.stringify(view.classes)}'><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: file:; font-src data:; connect-src 'none'"><title>Butler</title><style>${css}html,body{height:100%}body{display:flex}body>div{flex:1}`;
  const suffix = `</style></head><body>${view.html}<script src="mark.js"></script><script src="state.js"></script></body></html>`;
  const html = `${prefix}@font-face{font-family:"Pretendard Variable";font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${fontBytes.toString("base64")}) format("woff2")}${suffix}`;
  const sizes = { html: Buffer.byteLength(prefix + suffix), font: fontBytes.length, mark: Buffer.byteLength(mark), state: Buffer.byteLength(state) };
  for (const [name, budget] of Object.entries({ html: 20_480, font: 40_960, mark: 10_240, state: 3072 })) {
    if (sizes[name as keyof typeof sizes] > budget) throw new Error(`${name} exceeds lifecycle budget: ${sizes[name as keyof typeof sizes]} > ${budget}`);
  }
  const outputs = { "lifecycle.html": html, "mark.js": mark, "state.js": state, "copy.json": JSON.stringify(lifecycleCopy), "manifest.json": JSON.stringify(manifest, null, 2) + "\n" };
  if (!check) mkdirSync(lifecycleOutput, { recursive: true });
  for (const [name, output] of Object.entries(outputs)) {
    if (check) { if (readFileSync(join(lifecycleOutput, name), "utf8") !== output) throw new Error(`Lifecycle window is stale: ${name}`); }
    else writeFileSync(join(lifecycleOutput, name), output);
  }
  console.log(JSON.stringify({ lifecycleBytes: sizes, check }));
}
if (import.meta.main) await buildLifecycleAssets(process.argv.includes("--check"));
