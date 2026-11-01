// test-category: security
// Settings › Hooks lists the saved answers about project folders' hooks, and clearing one brings its
// question back. Real app with a real Agent; only the Electron main process's admin header is supplied here.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(output, "Set BUTLER_SMOKE_SCREENSHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });

const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
const settings = await server.api<{ default_project_workspace_path: string }>("/settings");
// Answers are kept by resolved path, as the Agent reads the folder.
mkdirSync(settings.default_project_workspace_path, { recursive: true });
const workspaceRoot = realpathSync(settings.default_project_workspace_path);
const browser = await launchSmokeBrowser();
const errors: string[] = [];
let current: Page | null = null;

type Language = "ko" | "en";
const folders = [
  { name: "butler", run: true },
  { name: "website-redesign", run: false },
  { name: "client-reports-2026", run: true },
];

/** A project for each folder, with hooks, answered through the app's own route. */
async function answerAll() {
  for (const { name, run } of folders) {
    const root = join(workspaceRoot, name);
    mkdirSync(join(root, ".butler"), { recursive: true });
    writeFileSync(join(root, ".butler/hooks.json"), JSON.stringify({ version: 1, hooks: [
      { id: "lint", event: "Stop", type: "command", command: "bun run lint" }] }));
    const { project } = await server.api<{ project: { id: string } }>("/projects", { method: "POST",
      body: JSON.stringify({ source: "workspace_folder", display_name: name, workspace_path: name }) });
    const route = `/projects/${project.id}/folder-trust`;
    const { question } = await server.api<{ question: { hooks: unknown[] } | null }>(route);
    if (question) await server.api(route, { method: "POST", body: JSON.stringify({ trusted: run, hooks: question.hooks }) });
  }
}

async function question(name: string) {
  const { projects } = await server.api<{ projects: { id: string; display_name: string }[] }>("/projects");
  const project = projects.find((candidate) => candidate.display_name === name)!;
  return (await server.api<{ question: unknown }>(`/projects/${project.id}/folder-trust`)).question;
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
}

/** Settings › Hooks in a fresh page. */
async function open(language: Language, theme: string, width: number): Promise<Page> {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
  const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  current = page;
  page.on("pageerror", (error) => errors.push(error.message));
  await server.signIn(page);
  await page.route(`${server.url}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = path.startsWith("/hooks") ? { ...server.authHeaders, "x-butler-admin": secret } : server.authHeaders;
    await route.continue({ headers: { ...route.request().headers(), ...headers } });
  });
  await page.goto(server.url);
  await page.locator('[data-test-class="composer-card"]').waitFor();
  const sidebar = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).click();
  await page.getByRole("button", { name: copy.settings.sections.hooks, exact: true }).click();
  return page;
}

const section = (page: Page) => page.locator('[data-settings-section-id="hook-folders"]');

async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} scrolls sideways`);
  await section(page).screenshot({ path: join(output!, `${name}.png`) });
}

const cells = (["light", "dark"] as const).flatMap((theme) => ([["desktop", 1280], ["phone", 390]] as const)
  .flatMap(([device, width]) => (["ko", "en"] as const).map((language) => ({ theme, device, width, language }))));

try {
  for (const { theme, device, width, language } of cells) {
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US").settings.hooks;
    const page = await open(language, theme, width);
    await section(page).getByText(copy.foldersEmpty, { exact: true }).waitFor();
    await shot(page, `empty-${theme}-${device}-${language}`);
    await page.close();
  }
  for (const { theme, device, width, language } of cells) {
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US").settings.hooks;
    await answerAll();
    const page = await open(language, theme, width);
    const text = section(page);
    for (const { name } of folders) await text.getByText(join(workspaceRoot, name), { exact: false }).first().waitFor();
    assert.equal(await text.getByText(copy.folderDoesNotRun, { exact: true }).count(), 1);
    assert.equal(await text.getByText(copy.folderRuns, { exact: true }).count(), 2);
    await shot(page, `folders-${theme}-${device}-${language}`);

    // Clearing the mistaken "don't run" brings its question back, and nothing else changes.
    const cleared = join(workspaceRoot, "website-redesign");
    await section(page).getByRole("button", { name: `${copy.clearAnswer}: ${cleared}`, exact: false }).click();
    await page.getByText(copy.answerCleared, { exact: true }).first().waitFor();
    await text.getByText(copy.folderDoesNotRun, { exact: true }).waitFor({ state: "detached" });
    assert.equal(await text.getByText(copy.folderRuns, { exact: true }).count(), 2);
    assert.notEqual(await question("website-redesign"), null, "the question is back");
    assert.equal(await question("butler"), null, "other answers stay");
    await shot(page, `cleared-${theme}-${device}-${language}`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Hook answers: ${cells.length} cells, empty, folders, cleared`);
  console.log("PASS");
} catch (error) {
  await (current as Page | null)?.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await browser.close();
  await server.stop();
}
