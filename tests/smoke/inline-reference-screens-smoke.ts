/** Before/after screen captures using unchanged product components in a Vite fixture. */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const root = process.cwd();
const baselineRef = process.env.BUTLER_INLINE_BASE_REF ?? "c54d1b761";
const ui = join(root, "packages/butler-app/client/ui");
const temp = mkdtempSync(join(tmpdir(), "butler-reference-screens-"));
const copy = join(temp, "packages/butler-app/client/ui");
const names = ["message", "project-document", "artifact", "about", "welcome", "consent", "key"];
const files = ["conversation/MessageMarkdown", "management/ProjectDocumentMarkdownContent", "artifacts/ArtifactViewer",
  "settings/AboutSettings", "first-run/FirstRunWelcome", "first-run/FirstRunConsent", "first-run/FirstRunKeyForm"];
cpSync(ui, copy, { recursive: true, filter: source => !source.includes("/node_modules") && !source.includes("/dist") });
symlinkSync(join(ui, "node_modules"), join(copy, "node_modules"), "dir");
symlinkSync(join(root, "packages/butler-app/client/shared"), join(temp, "packages/butler-app/client/shared"), "dir");
symlinkSync(join(root, "packages/butler-app/client/electron"), join(temp, "packages/butler-app/client/electron"), "dir");
for (const name of ["butler-i18n", "butler-progress-projection", "project-ledger"]) {
  symlinkSync(join(root, "packages", name), join(temp, "packages", name), "dir");
}
for (const file of files) {
  const relative = `packages/butler-app/client/ui/src/components/${file}.tsx`;
  writeFileSync(join(copy, "src/components", `${file}.tsx`), execFileSync("git", ["show", `${baselineRef}:${relative}`], { cwd: root }));
}
for (const child of readdirSync(root, { withFileTypes: true })) {
  if (!["packages", ".git", "deploy"].includes(child.name)) symlinkSync(join(root, child.name), join(temp, child.name), child.isDirectory() ? "dir" : "file");
}
for (const child of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!["butler-app", "butler-i18n", "butler-progress-projection", "project-ledger"].includes(child.name)) {
    symlinkSync(join(root, "packages", child.name), join(temp, "packages", child.name), child.isDirectory() ? "dir" : "file");
  }
}
cpSync(join(root, "deploy"), join(temp, "deploy"), { recursive: true });
cpSync(join(root, "tests/fixtures/inline-reference/screens.tsx"), join(copy, "screen-fixture.tsx"));
const entry = join(copy, "screens.html");
writeFileSync(entry, "<html><body><div id=\"root\"></div><script type=\"module\" src=\"./screen-fixture.tsx\"></script></body></html>");
const browser = await launchSmokeBrowser().catch(error => { rmSync(temp, { recursive: true, force: true }); throw error; });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/app-info", route => route.fulfill({ json: { data: { name: "Butler", version: "fixture", repository_url: "https://cached.invalid/owner/repo", protocol_version: "fixture" } } }));
  await page.route("**/message-files/*", route => route.fulfill({ contentType: "text/markdown", body: "# [Artifact](https://cached.invalid/artifact)" }));
  await page.route("**/favicons?host=*", route => route.fulfill({ status: 404, headers: { "cache-control": "private, no-store" } }));
  for (const stage of ["before", "after"]) {
    if (stage === "after") for (const file of files) {
      writeFileSync(join(copy, "src/components", `${file}.tsx`), readFileSync(join(ui, "src/components", `${file}.tsx`)));
    }
    process.chdir(copy);
    const dist = join(temp, `${stage}-dist`);
    await build({ root: copy, logLevel: "error", build: { outDir: dist, rolldownOptions: { input: entry } } });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const pathname = new URL(request.url).pathname;
      const file = Bun.file(join(dist, pathname === "/" ? "screens.html" : pathname));
      return new Response(file);
    } });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const language of ["en", "ko"]) for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
        await page.goto(`${base}/?language=${language}&theme=${theme}`);
        await page.locator('[data-test-class="about-app-repository"]').getByRole("link").waitFor();
        await page.getByText("Artifact", { exact: true }).waitFor();
        const output = resolve(root, ".tmp/inline-reference/screens", stage);
        mkdirSync(output, { recursive: true });
        for (const name of names) {
          const screen = page.locator(`[data-test-class="reference-screen-${name}"]`);
          if (stage === "after") {
            assert(await screen.locator('a[data-kind="external"]').count() > 0, name);
            assert(await screen.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name} overflow at ${width}`);
          }
          await screen.screenshot({ path: join(output, `${name}-${language}-${theme}-${width}.png`) });
        }
      }
    } finally { server.stop(true); }
  }
  console.log(JSON.stringify({ ok: true, screenshots: 112, screens: names }));
} finally { process.chdir(root); try { await browser.close(); } finally { rmSync(temp, { recursive: true, force: true }); } }
