// E2E-first: real settings containers -> HTTP stub gateway -> DOM feedback.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { installNotificationReplay } from "../support/notification-replay";
import { ERROR_COPY } from "../support/settings-error-copy";
import { getAppCopy } from "../../packages/butler-i18n/src";

const baseline = process.argv.includes("--baseline");
const root = resolve(process.env.SETTINGS_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
const output = resolve(`.tmp/settings-errors/${baseline ? "before" : "after"}`);
mkdirSync(output, { recursive: true });
const raw = "RAW_GATEWAY_DETAIL secret-source-id\nRAW_SECOND_LINE";
let code = "";
let rejects = 0;
const requests: { path: string; method: string; code: string }[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  requests.push({ path: url.pathname, method: request.method, code });
  if (request.method !== "GET" || url.pathname === "/local-models/discover" || (url.pathname === "/archives" && url.searchParams.get("offset") !== "0")) {
    rejects++;
    return Response.json({ error: { code: code || "unrecognized_error", message: raw } }, { status: 400 });
  }
  const payloads: Record<string, unknown> = {
    "/mcp-servers": { servers: [] },
    "/skills": { core: [], user: [{ name: "release-notes", description: "Draft release notes.", source: "internal-source-id", file_path: "", user_invocable: true }], projects: [] },
    "/wallpaper-assets": { assets: [] }, "/wallpaper-modules": { modules: [] },
    "/archives": { projects: [], sessions: [{ id: "archive", title: "Archived chat", kind: "chat", last_activity_at: "2026-10-01T00:00:00Z" }], pagination: { has_more: true } },
  };
  if (url.pathname in payloads) return Response.json({ protocol_version: "butler.app.v1", data: payloads[url.pathname] });
  const file = Bun.file(join(root, url.pathname));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await launchSmokeBrowser();
let cases = 0;
const measurements: unknown[] = [];
function text(key: string, locale: string) {
  const entry = ERROR_COPY.find(entry => entry.key === key);
  assert(entry, key); return locale === "ko" ? entry.ko : entry.en;
}
async function rejectRequest(page: Page, path: string, action: () => Promise<unknown>) {
  const expectedCode = code || "unrecognized_error";
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path && response.status() === 400).catch(async cause => {
      throw new Error(JSON.stringify({ path, expectedCode, url: page.url(), requests: requests.slice(-5),
        input: await page.locator("#first-run-api-key").evaluate(element => ({ length: (element as HTMLInputElement).value.length, invalid: element.getAttribute("aria-invalid"), disabled: (element as HTMLInputElement).disabled })).catch(() => null),
      }), { cause });
    }),
    action(),
  ]);
  assert.equal((await response.json()).error.code, expectedCode, "each requested code reaches the renderer");
}
async function capture(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  if (!baseline) assert.equal(await page.getByText(/RAW_GATEWAY_DETAIL|RAW_SECOND_LINE/u).count(), 0, "no server text");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name);
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  await page.evaluate(() => document.querySelectorAll(".main-screen-theme-bloom").forEach(element => element.classList.replace("main-screen-theme-bloom", "main-screen-theme-none")));
  await page.screenshot({ path: join(output, `${name}-plain.png`), fullPage: true });
  await page.evaluate(() => document.querySelectorAll(".main-screen-theme-none").forEach(element => element.classList.replace("main-screen-theme-none", "main-screen-theme-bloom")));
}
async function field(page: Page, id: string, expected: string) {
  const control = page.locator(`#${id}`);
  await page.waitForFunction(id => document.getElementById(id)?.getAttribute("aria-invalid") === "true", id);
  const description = await control.getAttribute("aria-describedby");
  assert(description, `${id}: aria-describedby`);
  const error = page.locator(`#${description.split(" ").at(-1)}`);
  await page.waitForFunction(({ id, expected }) => document.getElementById(id)?.textContent?.trim() === expected, { id: description.split(" ").at(-1)!, expected });
  assert.equal(await error.innerText(), expected);
  assert.equal(await control.evaluate(element => element === document.activeElement), true, `${id}: first invalid focus`);
  const a = await control.boundingBox(); const b = await error.boundingBox();
  assert(a && b && b.y >= a.y + a.height - 1, `${id}: error below control`);
  measurements.push({ id, gap: Number((b.y - a.y - a.height).toFixed(2)) });
}
async function toast(page: Page, expected: string) {
  const item = page.locator('[data-sonner-toast][data-type="error"]').filter({ has: page.getByText(expected, { exact: true }) }).first();
  await item.getByText(expected, { exact: true }).waitFor();
  assert.equal(await item.locator("[data-description]").count(), 0, "one-line toast");
  assert.equal(await item.innerText(), expected);
}
async function tileField(page: Page, selector: string, expected: string) {
  const button = page.locator(selector);
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-invalid") === "true", selector);
  const errorId = await button.getAttribute("aria-describedby"); assert(errorId);
  const error = page.locator(`[id="${errorId}"]`);
  await page.waitForFunction(({ id, expected }) => {
    const element = document.getElementById(id)?.cloneNode(true) as HTMLElement | undefined;
    element?.querySelectorAll("button").forEach(button => button.remove());
    return element?.textContent?.trim() === expected;
  }, { id: errorId, expected }).catch(async cause => {
    await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
    throw new Error(JSON.stringify({ selector, code, expected, actual: await error.textContent() }), { cause });
  });
  assert.equal(await button.evaluate(element => element === document.activeElement), true, "invalid import focus");
  const a = await button.boundingBox(); const b = await error.boundingBox();
  assert(a && b && b.y >= a.y + a.height - 1, "import error under control");
  assert.equal(await page.locator('[data-sonner-toast][data-type="error"]').count(), 0);
}
async function run(width: number, theme: string, locale: string, transport: string) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  if (transport === "preload") await installNotificationReplay(page, `http://127.0.0.1:${server.port}`);
  const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
  const prefix = `${transport}-${width}-${theme}-${locale}`;
  const open = async (mode: string) => {
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=settings-errors&mode=${mode}&theme=${theme}&locale=${locale}`);
    await page.locator('[data-harness-ready="true"]').waitFor();
  };
  await open("mcp");
  await page.getByRole("button", { name: copy.settings.actions.addMcpServer, exact: true }).click();
  await capture(page, `${prefix}-mcp-default`);
  await page.locator("#mcp-server-id").fill("github");
  await page.locator("#mcp-stdio-command").fill("npx");
  const save = page.getByRole("button", { name: copy.common.save, exact: true });
  for (const [errorCode, id, key] of [
    ["mcp_server_id_required", "mcp-server-id", "settings.mcpIdRequired"],
    ["mcp_server_id_invalid", "mcp-server-id", "settings.mcpIdInvalid"],
    ["mcp_command_required", "mcp-stdio-command", "settings.mcpCommandRequired"],
    ["mcp_url_required", "mcp-http-url", "settings.mcpUrlRequired"],
  ]) {
    code = errorCode;
    if (id === "mcp-http-url") { await page.locator("#mcp-transport").selectOption("http"); await page.locator(`#${id}`).fill("https://example.com"); }
    await rejectRequest(page, "/mcp-servers", () => save.click());
    if (!baseline) { await field(page, id, text(key, locale)); cases++; }
    await capture(page, `${prefix}-${errorCode}`);
    await page.locator(`#${id}`).fill(id === "mcp-server-id" ? `github-${errorCode}` : "updated");
    if (!baseline) assert.equal(await page.locator(`#${id}`).getAttribute("aria-invalid"), "false", "edit clears error");
  }
  if (!baseline) for (const errorCode of ["mcp_server_save_failed", "mcp_server_update_failed", "mcp_config_invalid", "mcp_secret_unreadable", "mcp_server_not_found", "mcp_registry_unavailable", "unrecognized_error"]) {
    code = errorCode; await rejectRequest(page, "/mcp-servers", () => save.click());
    await toast(page, text(errorCode === "mcp_server_not_found" ? "settings.mcpErrors.notFound" : errorCode === "mcp_registry_unavailable" ? "settings.mcpErrors.unavailable" : "settings.mcpErrors.save", locale)); cases++;
  }
  await open("skills");
  await page.getByText("release-notes", { exact: true }).waitFor();
  await capture(page, `${prefix}-skills-default`);
  if (!baseline) assert.equal(await page.getByText("internal-source-id", { exact: true }).count(), 0);
  for (const errorCode of ["skill_archive_invalid", "skill_archive_path_invalid", "skill_path_invalid", "skill_file_too_large", "unknown_skill_error"]) {
    code = errorCode;
    await page.getByRole("button", { name: copy.settings.actions.importSkill, exact: true }).click();
    await rejectRequest(page, "/skills/import", () => page.locator('input[type="file"]').setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from("invalid") }));
    if (!baseline) {
      const key = errorCode === "skill_file_too_large" ? "tooLarge" : errorCode === "unknown_skill_error" ? "import" : "invalid";
      await tileField(page, '[aria-invalid="true"]', text(`settings.skillErrors.${key}`, locale)); cases++;
    }
  }
  await capture(page, `${prefix}-skills-error`);
  await open("wallpaper");
  await page.locator('[data-option="import-module"]').waitFor();
  await capture(page, `${prefix}-wallpaper-default`);
  for (const errorCode of ["wallpaper_module_archive_invalid", "wallpaper_module_invalid", "wallpaper_module_request_invalid", "wallpaper_module_archive_too_large", "wallpaper_module_file_too_large", "wallpaper_module_exists", "unknown_module_error"]) {
    code = errorCode;
    await rejectRequest(page, "/wallpaper-modules/import", () => page.locator('[data-option="import-module"] input').setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from("invalid") }));
    if (!baseline) {
      const key = errorCode.includes("too_large") ? "moduleTooLarge" : errorCode.endsWith("exists") ? "moduleExists" : errorCode.startsWith("unknown") ? "moduleImportFailed" : "moduleInvalid";
      await tileField(page, '[data-option="import-module"] > button', text(`settings.wallpaper.${key}`, locale)); cases++;
    }
  }
  await capture(page, `${prefix}-wallpaper-error`);
  if (!baseline) for (const errorCode of ["wallpaper_unsupported_type", "wallpaper_image_invalid", "wallpaper_dimensions_unsupported", "wallpaper_too_large"]) {
    code = errorCode;
    await rejectRequest(page, "/wallpapers", () => page.locator('[data-option="upload"] input').setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("invalid") }));
    await tileField(page, '[data-option="upload"] button', text(`settings.wallpaper.${errorCode === "wallpaper_too_large" ? "imageTooLarge" : "imageUnsupported"}`, locale)); cases++;
  }
  await capture(page, `${prefix}-image-error`);
  await open("project-wallpaper");
  await page.locator('[data-test-class~="project-wallpaper-dialog"]').waitFor();
  await capture(page, `${prefix}-project-wallpaper-default`);
  code = "wallpaper_module_archive_invalid";
  await rejectRequest(page, "/wallpaper-modules/import", () => page.locator('[data-option="import-module"] input').setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from("invalid") }));
  if (!baseline) { await tileField(page, '[data-option="import-module"] > button', text("settings.wallpaper.moduleInvalid", locale)); cases++; }
  await capture(page, `${prefix}-project-wallpaper-error`);
  await open("archives"); await page.getByText("Archived chat", { exact: true }).waitFor();
  await capture(page, `${prefix}-archives-default`);
  code = "archive_restore_failed";
  await page.getByRole("button", { name: copy.interfaceDetails.unarchive, exact: true }).click();
  if (!baseline) { await toast(page, text("settings.archiveErrors.restore", locale)); cases++; }
  code = "archive_load_failed";
  await page.getByRole("button", { name: copy.common.more, exact: true }).click();
  if (!baseline) { await toast(page, text("settings.archiveErrors.loadMore", locale)); cases++; }
  await capture(page, `${prefix}-archives-error`);
  await open("local"); await capture(page, `${prefix}-local-default`);
  code = "local_model_discovery_failed";
  await page.locator("#local-model-server-url").fill("http://localhost:8000");
  await rejectRequest(page, "/model-catalog/local/discover", () => page.getByRole("button", { name: copy.settings.localModels.discoverModels, exact: true }).click());
  if (!baseline) { await field(page, "local-model-server-url", text("settings.localModelErrors.discover", locale)); cases++; }
  await capture(page, `${prefix}-local-error`);
  if (!baseline) {
    await page.locator("#local-model-id").fill("stub-model");
    for (const errorCode of ["local_model_registration_failed", "local_model_update_failed"]) {
      code = errorCode;
      await rejectRequest(page, "/model-catalog/local-models", () => page.getByRole("button", { name: copy.settings.localModels.registerModel, exact: true }).click());
      await toast(page, text("settings.localModelErrors.register", locale)); cases++;
    }
  }
  await open("keys"); await capture(page, `${prefix}-keys-default`);
  for (const errorCode of ["provider_auth_error", "credential_key_invalid", "provider_permission_error", "provider_quota_exhausted", "provider_network_error", "provider_timeout"]) {
    code = errorCode;
    await rejectRequest(page, "/setup/credentials/verify", () => page.locator("#first-run-api-key").fill(`stub-key-${errorCode}`));
    if (baseline) await page.waitForFunction(() => document.getElementById("first-run-api-key")?.getAttribute("aria-invalid") === "true");
    if (!baseline) {
      const key = ["provider_auth_error", "credential_key_invalid"].includes(errorCode) ? "invalid"
        : ["provider_permission_error", "provider_quota_exhausted"].includes(errorCode) ? "noaccess" : "network";
      await field(page, "first-run-api-key", text(`firstRun.keyErrors.${key}`, locale)); cases++;
    }
  }
  await capture(page, `${prefix}-keys-error`);
  await open("save"); await capture(page, `${prefix}-save-default`);
  code = "invalid_settings_request";
  await page.locator('[data-setting-id="desktop-notifications"] button').click();
  if (!baseline) { await toast(page, text("settings.errors.saveFailed", locale)); cases++; }
  await capture(page, `${prefix}-save-error`);
  if (!baseline) {
    code = "settings_model_unavailable";
    await rejectRequest(page, "/settings", () => page.locator('[data-setting-id="desktop-notifications"] button').click());
    await toast(page, text("serverErrors.settings_model_unavailable", locale)); cases++;
  }
  if (!baseline) assert.equal(await page.getByText(/RAW_GATEWAY_DETAIL|RAW_SECOND_LINE/u).count(), 0);
  await context.close();
}
try {
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"]) for (const transport of baseline ? ["http"] : ["http", "preload"]) {
    if (process.env.SETTINGS_SMOKE_CASE && process.env.SETTINGS_SMOKE_CASE !== `${width}-${theme}-${locale}-${transport}`) continue;
    await run(width, theme, locale, transport);
  }
  console.log(JSON.stringify({ ok: true, baseline, cases, rejects, measurements, screenshots: output, modelCalls: 0 }));
} finally { await browser.close(); await server.stop(true); }
