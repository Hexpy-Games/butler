// test-category: race
import { strict as assert } from "node:assert";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(output, "Set BUTLER_SMOKE_SCREENSHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });
const folder = mkdtempSync(join(tmpdir(), "butler-project-folder-"));
const secret = randomBytes(32).toString("hex");
const payload = Buffer.from(JSON.stringify({ path: folder, issued_at: Date.now(), expires_at: Date.now() + 300_000 })).toString("base64url");
const token = `v1.${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist"),
  env: { BUTLER_PROJECT_FOLDER_TOKEN_SECRET: secret } });
const settings = await server.api<{ default_project_workspace_path: string }>("/settings");
const workspaceRoot = settings.default_project_workspace_path;
for (const path of ["outer/inner/deep", "outer/inner/sibling", "outer/sibling", "sibling"]) {
  mkdirSync(join(workspaceRoot, path), { recursive: true });
}
const browser = await launchSmokeBrowser();
const screenshots: string[] = [];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    // Scroll-driven animations follow scroll position, not time, and never finish.
    animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity ||
      animation.playState !== "running"));
}

async function openDialog(page: Page) {
  const showSidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole("button", { name: "스페이스 메뉴", exact: true }).click();
  assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["새 그룹", "새 프로젝트", "아카이브"]);
  await page.getByRole("menuitem", { name: "새 프로젝트", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await settle(page);
}

async function picker(page: Page, result: Record<string, unknown>, fail = false) {
  await page.evaluate(({ result, fail }) => {
    window.butlerApp = { selectProjectFolder: async () => {
      if (fail) throw new Error("Fixture picker failure");
      return result;
    } };
  }, { result, fail });
  const input = page.getByLabel("프로젝트 이름", { exact: true });
  const name = await input.inputValue();
  await input.fill(`${name} `);
  await input.fill(name);
  await page.locator("#project-create-folder").click();
  await page.waitForFunction(() => !document.querySelector("form[aria-busy=true]"));
}

async function captureMatrix(page: Page) {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    await page.goto(server.url);
    await page.locator('[data-test-class="composer-card"]').waitFor();
    if (width === 375) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
    const shot = async (state: string) => {
      await page.mouse.move(0, 0);
      await settle(page);
      const path = join(output!, `after-${width}-${theme}-${state}.png`);
      await page.screenshot({ path }); screenshots.push(path);
    };
    const nav = page.getByRole("navigation", { name: "대화 시작과 검색", exact: true });
    assert.deepEqual((await nav.locator('[data-slot="nav-row-label"]').allTextContents()).slice(0, 3),
      ["새 대화", "검색", "예약 작업"]);
    await shot("header"); await shot("top-nav");
    await page.getByRole("button", { name: "스페이스 메뉴", exact: true }).click();
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["새 그룹", "새 프로젝트", "아카이브"]);
    await shot("menu");
    await page.getByRole("menuitem", { name: "새 프로젝트", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await shot("dialog-empty");
    assert.equal(await page.evaluate(() => Boolean(window.butlerApp)), false);
    const choose = page.getByRole("button", { name: "폴더 선택", exact: true });
    assert.equal(await choose.getAttribute("aria-disabled"), null);
    await choose.click();
    await page.getByRole("navigation", { name: "폴더 경로", exact: true }).waitFor();
    await page.getByRole("button", { name: "outer", exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "이 폴더 사용", exact: true }).isDisabled());
    await shot("browse-root");
    await page.keyboard.press("Enter");
    await page.locator('[data-test-class="project-folder-up"]').waitFor();
    await shot("browse-nested-up-row");
    await page.getByRole("button", { name: "inner", exact: true }).click();
    await page.getByRole("button", { name: "deep", exact: true }).click();
    await page.getByText("하위 폴더 없음", { exact: true }).waitFor();
    await shot("browse-nested");
    await page.keyboard.press("Escape");
    await page.getByLabel("프로젝트 이름", { exact: true }).waitFor();
    await picker(page, { cancelled: true });
    await shot("auto");
    const path = String.raw`C:\Users\example\Projects\workspaces\a-very-long-project-folder-path\demo-project`;
    await picker(page, { display_name: "demo-project", folder_path: path, folder_selection_token: "fixture" });
    assert.equal(await page.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "demo-project");
    const pathText = page.getByLabel(path, { exact: true });
    assert.equal(await pathText.textContent(), `demo-project${path.slice(0, path.lastIndexOf("\\"))}`);
    assert(await pathText.locator("[data-truncate=true]").last().evaluate(el => el.scrollWidth > el.clientWidth));
    await pathText.hover();
    await page.getByRole("tooltip", { name: path, exact: true }).waitFor();
    await shot("picked");
    const dialog = await page.getByRole("dialog").boundingBox();
    for (const name of ["변경", "새 폴더로 되돌리기", "취소", "만들기"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert(dialog && box && box.x >= dialog.x && box.x + box.width <= dialog.x + dialog.width, `${name} stays inside dialog`);
    }
    await page.getByRole("button", { name: "취소", exact: true }).click();
    await page.evaluate(() => { delete window.butlerApp; });
    console.log(`Sidebar matrix: ${width} ${theme}`);
  }
}

async function exerciseCreation(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(server.url);
  await page.locator('[data-test-class="composer-card"]').waitFor();
  const showSidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole("button", { name: "스페이스 메뉴", exact: true }).click();
  await page.getByRole("menuitem", { name: "새 그룹", exact: true }).click();
  await page.getByLabel("그룹 이름", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("그룹 이름", { exact: true }).inputValue(), "");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await settle(page);
  await page.getByText("예약 작업", { exact: true }).first().click();
  await page.locator('[data-test-class="automations-view"]').waitFor();
  await openDialog(page);
  const input = page.getByLabel("프로젝트 이름", { exact: true });
  await picker(page, { cancelled: true });
  assert.equal(await input.inputValue(), "");
  assert.equal(await page.getByRole("alert").count(), 0);
  await picker(page, {}, true);
  await page.getByRole("alert").waitFor();
  await input.fill("Custom project");
  const selection = { display_name: basename(folder), folder_path: folder, folder_selection_token: token };
  await picker(page, selection);
  assert.equal(await input.inputValue(), "Custom project");
  await picker(page, { cancelled: true });
  assert(await page.getByLabel(folder, { exact: true }).isVisible());
  await page.evaluate(() => { delete window.butlerApp; });
  await page.route("**/projects", route => route.request().method() === "POST"
    ? route.fulfill({ status: 500, json: { ok: false, error: { code: "fixture_failure" } } }) : route.continue());
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(await input.inputValue(), "Custom project");
  await page.unroute("**/projects");
  const submitted = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/projects");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  const body = (await submitted).postDataJSON();
  assert.equal(body.source, "existing_folder"); assert.equal(body.display_name, "Custom project");
  assert.equal(body.folder_selection_token, token);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const projects = await server.api<{ projects: Array<{ id: string; display_name: string }> }>("/projects");
  const project = projects.projects.find(p => p.display_name === "Custom project"); assert(project);
  const duplicate = await server.api<{ project: { id: string } }>("/projects", { method: "POST",
    body: JSON.stringify({ source: "existing_folder", display_name: "Another name", folder_selection_token: token }) });
  assert.equal(duplicate.project.id, project.id);
  await openDialog(page); await input.fill("Scratch project");
  const scratch = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/projects");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  assert.deepEqual((await scratch).postDataJSON(), { source: "scratch", display_name: "Scratch project" });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

async function exerciseBrowserCreation(page: Page) {
  await openDialog(page);
  await page.locator("#project-create-folder").click();
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  const up = page.locator('[data-test-class="project-folder-up"]');
  const rows = page.locator('[data-test-class="project-folder-row"]');
  const breadcrumb = page.getByRole("navigation", { name: "폴더 경로", exact: true });
  const focused = async (name: string) => {
    await page.waitForFunction(name => document.activeElement?.textContent === name, name);
    assert(await row(name).evaluate(el => el === document.activeElement));
  };
  const descend = async () => {
    for (const name of ["outer", "inner", "deep"]) {
      await row(name).focus(); await page.keyboard.press("Enter");
      await up.waitFor(); await focused("상위 폴더");
      assert.equal(await page.locator('[data-test-class="project-folder-scroll"] [data-test-class^="project-folder-"][role="button"]').first().getAttribute("data-test-class"), "project-folder-up");
      assert.equal(await rows.locator("svg").count(), await rows.count());
      await breadcrumb.getByText(name, { exact: true }).waitFor();
    }
  };
  await row("outer").waitFor();
  await focused("outer");
  assert.equal(await up.count(), 0);
  assert.equal(await rows.locator("svg").count(), await rows.count());
  await page.keyboard.press("End"); await focused("sibling");
  await page.keyboard.press("Home"); await focused("outer");
  await descend();
  for (const [key, child, parent] of [["Enter", "deep", "inner"], ["Backspace", "inner", "outer"], ["Alt+ArrowUp", "outer", basename(workspaceRoot)]]) {
    await page.keyboard.press(key);
    await breadcrumb.getByText(parent, { exact: true }).waitFor();
    await focused(child);
  }
  assert.equal(await up.count(), 0);
  await descend();
  await breadcrumb.getByRole("button", { name: basename(workspaceRoot), exact: true }).click();
  await focused("outer");
  assert.equal(await up.count(), 0);
  await descend();
  await page.keyboard.press("End"); await focused("상위 폴더");
  await page.getByText("하위 폴더 없음", { exact: true }).waitFor();
  await row("이 폴더 사용").click();
  const input = page.getByLabel("프로젝트 이름", { exact: true });
  assert.equal(await input.inputValue(), "deep");
  await row("변경").click();
  await page.getByRole("navigation", { name: "폴더 경로", exact: true }).getByText("deep", { exact: true }).waitFor();
  await row("뒤로가기").click();
  assert.equal(await input.inputValue(), "deep");
  await input.fill("Browser project");
  const submitted = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/projects");
  await row("만들기").click();
  assert.deepEqual((await submitted).postDataJSON(), { source: "workspace_folder", display_name: "Browser project", workspace_path: "outer/inner/deep" });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const projects = await server.api<{ projects: Array<{ display_name: string }> }>("/projects");
  assert(projects.projects.some(project => project.display_name === "Browser project"));
}

async function exerciseBrowserPagination(page: Page) {
  for (let index = 0; index < 105; index += 1) mkdirSync(join(workspaceRoot, "pages", `Folder-${String(index).padStart(3, "0")}`), { recursive: true });
  await openDialog(page);
  await page.locator("#project-create-folder").click();
  await page.getByRole("button", { name: "pages", exact: true }).click();
  const rows = page.locator('[data-test-class="project-folder-row"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="project-folder-row"]').length === 100);
  await rows.first().focus();
  await page.keyboard.press("End");
  assert(await rows.last().evaluate(el => el === document.activeElement));
  await page.keyboard.press("ArrowUp");
  assert(await rows.nth(98).evaluate(el => el === document.activeElement));
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert(await rows.first().evaluate(el => el === document.activeElement));
  await page.keyboard.press("ArrowUp");
  assert(await page.locator('[data-test-class="project-folder-up"]').evaluate(el => el === document.activeElement));
  await page.getByRole("button", { name: "더 보기", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="project-folder-row"]').length === 105);
  assert.equal(new Set(await rows.allTextContents()).size, 105);
  assert.equal(await page.getByRole("button", { name: "더 보기", exact: true }).count(), 0);
  const rootName = basename(workspaceRoot);
  await page.getByRole("button", { name: rootName, exact: true }).click();
  await page.getByRole("button", { name: "outer", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "취소", exact: true }).click();
}

async function exerciseFolderStates(page: Page) {
  await openDialog(page);
  const input = page.getByLabel("프로젝트 이름", { exact: true });
  for (const [path, base, parent] of [
    ["/", "/", ""], ["C:\\", "C:\\", ""], ["C:", "C:", ""],
    ["/alpha/beta/", "beta", "/alpha"], ["/beta", "beta", "/"],
    [String.raw`C:\beta`, "beta", "C:\\"],
  ]) {
    await input.fill("");
    await picker(page, { folder_path: path, folder_selection_token: "fixture" });
    assert.equal(await input.inputValue(), base);
    const value = page.getByLabel(path, { exact: true });
    assert.equal(await value.textContent(), `${base}${parent}`);
    await page.getByRole("button", { name: "새 폴더로 되돌리기", exact: true }).click();
    assert.equal(await input.inputValue(), base);
    assert(await page.locator("#project-create-folder").evaluate(el => el === document.activeElement));
    assert.equal(await page.getByRole("button", { name: "새 폴더로 되돌리기", exact: true }).count(), 0);
  }
  await input.fill("Typed name");
  await picker(page, { folder_path: "/alpha/beta", folder_selection_token: "fixture" });
  await page.evaluate(() => {
    window.butlerApp = { selectProjectFolder: () => new Promise(resolve => {
      window.addEventListener("fixture-picker-cancel", () => resolve({ cancelled: true }), { once: true });
    }) };
  });
  await page.locator("#project-create-folder").click();
  assert.equal(await page.locator("#project-create-folder").getAttribute("disabled"), "");
  assert(await page.getByRole("button", { name: "새 폴더로 되돌리기", exact: true }).isDisabled());
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-picker-cancel")));
  await page.waitForFunction(() => !document.querySelector("form[aria-busy=true]"));
  assert(await page.getByLabel("/alpha/beta", { exact: true }).isVisible());
  assert.equal(await input.inputValue(), "Typed name");
  await page.getByRole("button", { name: "새 폴더로 되돌리기", exact: true }).click();
  assert.equal(await input.inputValue(), "Typed name");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await page.evaluate(() => { delete window.butlerApp; });
}

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await server.signIn(page);
  await captureMatrix(page);
  await exerciseBrowserCreation(page);
  await exerciseBrowserPagination(page);
  await exerciseCreation(page);
  await exerciseFolderStates(page);
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(output, "screenshots.txt"), `${screenshots.join("\n")}\n`);
  console.log(JSON.stringify({ ok: true, screenshots: screenshots.length, modelCalls: 0,
    verified: ["menu", "group naming", "schedules", "picker cancellation", "picker error", "custom name", "creation error", "existing folder", "path dedupe", "scratch", "Windows/POSIX/root paths", "reset focus", "pending picker"] }));
} finally {
  await browser.close(); await server.stop(); rmSync(folder, { recursive: true, force: true });
}
