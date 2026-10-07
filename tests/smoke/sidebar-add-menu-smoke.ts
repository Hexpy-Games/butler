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
  assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["새 그룹", "새 프로젝트"]);
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
  await page.getByRole("button", { name: "폴더 선택", exact: true }).click();
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
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["새 그룹", "새 프로젝트"]);
    await shot("menu");
    await page.getByRole("menuitem", { name: "새 프로젝트", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await shot("dialog-empty");
    const unavailable = page.getByRole("button", { name: "데스크톱 앱에서 사용 가능", exact: true });
    assert(await unavailable.isDisabled());
    await unavailable.hover();
    await page.getByRole("tooltip", { name: "데스크톱 앱에서 사용 가능", exact: true }).waitFor();
    const path = "/Users/example/Projects/workspaces/a-very-long-project-folder-path/demo-project";
    await picker(page, { display_name: "demo-project", folder_path: path, folder_selection_token: "fixture" });
    assert.equal(await page.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "demo-project");
    const pathText = page.getByTitle(path, { exact: true });
    assert(await pathText.evaluate(el => el.scrollWidth > el.clientWidth));
    await shot("dialog-folder");
    const dialog = await page.getByRole("dialog").boundingBox();
    for (const name of ["폴더 선택", "취소", "만들기"]) {
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
  assert(await page.getByTitle(folder, { exact: true }).isVisible());
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

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await server.signIn(page);
  await captureMatrix(page);
  await exerciseCreation(page);
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(output, "screenshots.txt"), `${screenshots.join("\n")}\n`);
  console.log(JSON.stringify({ ok: true, screenshots: screenshots.length, modelCalls: 0,
    verified: ["menu", "group naming", "schedules", "picker cancellation", "picker error", "custom name", "creation error", "existing folder", "path dedupe", "scratch"] }));
} finally {
  await browser.close(); await server.stop(); rmSync(folder, { recursive: true, force: true });
}
