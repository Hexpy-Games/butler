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
const browser = await launchSmokeBrowser();
const screenshots: string[] = [];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
}

async function openDialog(page: Page) {
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
    const unavailable = page.getByRole("button", { name: "폴더 선택", exact: true });
    assert.equal(await unavailable.getAttribute("aria-disabled"), "true");
    assert.equal(await unavailable.getAttribute("disabled"), null);
    await unavailable.evaluate(el => (el as HTMLButtonElement).click());
    assert.equal(await page.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "");
    await unavailable.hover();
    await page.getByRole("tooltip", { name: "데스크톱 앱에서 사용 가능", exact: true }).waitFor();
    await settle(page);
    const webShot = join(output!, `after-${width}-${theme}-web-disabled.png`);
    await page.screenshot({ path: webShot }); screenshots.push(webShot);
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
  await exerciseCreation(page);
  await exerciseFolderStates(page);
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(output, "screenshots.txt"), `${screenshots.join("\n")}\n`);
  console.log(JSON.stringify({ ok: true, screenshots: screenshots.length, modelCalls: 0,
    verified: ["menu", "group naming", "schedules", "picker cancellation", "picker error", "custom name", "creation error", "existing folder", "path dedupe", "scratch", "Windows/POSIX/root paths", "reset focus", "pending picker"] }));
} finally {
  await browser.close(); await server.stop(); rmSync(folder, { recursive: true, force: true });
}
