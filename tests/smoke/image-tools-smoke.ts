// Real gateway, scripted chat and fake image provider: no live model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";
import { auditTabOrder } from "../support/focus-ring-clipping";
import { verifyImageToolsElectron } from "../support/image-tools-electron";
import { startImageProvider } from "../support/image-provider";

if (await runSmokeCases(["light", "dark"], "BUTLER_IMAGE_TOOLS_CASE", import.meta.path, { isolate: true })) {
  console.log(`Screenshots: ${process.env.BUTLER_IMAGE_TOOLS_SHOTS}`); process.exit(0);
}
const theme = process.env.BUTLER_IMAGE_TOOLS_CASE ?? "light";
const before = Bun.argv.includes("--before");
const output = process.env.BUTLER_IMAGE_TOOLS_SHOTS;
assert(output, "BUTLER_IMAGE_TOOLS_SHOTS must name a temp directory");
mkdirSync(output, { recursive: true });
const provider = startImageProvider();
const prompt = "Change the painted region to warm orange. ".repeat(30);
let call: { name: string; arguments: Record<string, unknown> } | undefined;
const server = await createNativeAppServer({ env: { OPENAI_BASE_URL: provider.base, BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0" },
  stubReply: request => request.stream ? "완료했습니다." : "{}",
  stubToolCall: request => {
    if (!request.stream || !Array.isArray(request.body.tools) || !request.body.tools.length) return null;
    const next = call; call = undefined;
    if (next?.name === "edit_image") {
      const grant = [...JSON.stringify(request.messages).matchAll(/\[Image editor: image (img_[a-z0-9]+)(?: · mask (img_[a-z0-9]+))?\]/gu)].at(-1);
      if (grant) next.arguments = { ...next.arguments, image: grant[1], ...(grant[2] ? { mask: grant[2] } : {}) };
    }
    return next ?? null;
  } });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let vite: { close: () => Promise<void> } | undefined;
let base = server.url;
const errors: string[] = [];
const requestTitle = "파란 그림을 만들어 주세요";
const pictureTitle = before ? "이미지 만들기" : requestTitle;
let lastSession: string | null = null;
let missingOutput: string | undefined;
async function capture(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(image => image.getClientRects().length).map(image => image.decode().catch(() => {})));
  });
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running" && animation.timeline instanceof DocumentTimeline
    && animation.effect?.getComputedTiming().iterations !== Infinity));
  await page.screenshot({ path: join(output!, `${before ? "before" : "after"}-${theme}-${name}.png`) });
}
async function captureResponsive(page: Page, name: string) {
  await capture(page, `${name}-1280`);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, `${name}-390`);
  await page.setViewportSize({ width: 1280, height: 900 });
}
async function openModels(page: Page) {
  await page.locator('[data-test-class="mac-window"]').waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("모델");
  await palette.getByRole("option").filter({ hasText: "모델" }).first().click();
  await palette.waitFor({ state: "detached" });
  await page.locator('[data-settings-section-id="image-models"]').scrollIntoViewIfNeeded();
}
async function send(page: Page, text: string) {
  await page.locator('[contenteditable="true"]').fill(text);
  await page.locator('[data-test-class="composer-send-button"]').click();
}
async function setAccess(page: Page, label: string) {
  const compact = page.locator('[data-slot="composer-compact-preview"]');
  if (await compact.isVisible()) await compact.click();
  await page.locator('[data-test-class="access-button"]').click();
  const persisted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/controls") && response.request().method() === "PATCH");
  await page.getByRole("button", { name: new RegExp(`^${label}`, "u") }).click();
  assert((await persisted).ok());
}
async function paint(page: Page) {
  const canvas = page.locator('[data-test-class="image-editor"] canvas');
  const bounds = (await canvas.boundingBox())!;
  assert(bounds.width > 100 && bounds.height > 100, "paint surface has usable dimensions");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .6, { steps: 8 }); await page.mouse.up();
}
async function librarySave(page: Page, image: string) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/library" && response.request().method() === "POST");
  await page.locator('[data-test-class="generated-image-card"]').first().getByRole("button", { name: "서랍에 저장", exact: true }).click();
  const saved = await response, sent = saved.request().postDataJSON();
  assert.equal(sent.title, pictureTitle);
  assert.equal(sent.asset, image); assert.equal(sent.url, "");
  assert(!("crop" in sent) && !("image" in sent), "asset reference only, no JPEG or legacy image field");
  assert(saved.ok(), `library save: HTTP ${saved.status()}`);
  await page.getByRole("button", { name: "서랍에 저장했어요", exact: true }).waitFor();
  const library = await server.api<{ items: Array<{ asset?: string; image_url?: string }> }>("/library?kind=scrap");
  const item = library.items.find(item => item.asset === image);
  assert(item?.image_url?.includes("signature="));
}
async function libraryPreview(page: Page, image: string) {
  const showSidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole("button", { name: "서랍", exact: true }).click();
  const saved = page.locator("[data-library-item]").filter({ hasText: pictureTitle }).first();
  await saved.locator("img").evaluate((picture: HTMLImageElement) => picture.decode());
  assert((await saved.locator("img").getAttribute("src"))?.includes(`/message-assets/${image}?`));
  await captureResponsive(page, "library");
  await saved.getByRole("button", { name: pictureTitle, exact: true }).click();
  await page.locator('[data-test-class="library-detail"] img').evaluate((picture: HTMLImageElement) => picture.decode());
  assert.equal(await page.getByRole("button", { name: "원본 페이지 열기", exact: true }).count(), 0);
  await captureResponsive(page, "library-detail");
}
try {
  if (before || Bun.argv.includes("--dev")) {
    const { createServer } = await import("../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js");
    const root = process.cwd(), sources = new Map<string, string>();
    const changed = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" }).trim().split("\n");
    for (const file of (before ? changed : []).filter(file => /\.(ts|tsx)$/u.test(file)))
      sources.set(resolve(file), execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" }));
    if (before && process.env.BUTLER_IMAGE_TOOLS_BASELINE) {
      sources.clear();
      for (const [path, source] of Object.entries(JSON.parse(readFileSync(process.env.BUTLER_IMAGE_TOOLS_BASELINE, "utf8")))) sources.set(path, source as string);
    }
    process.chdir(resolve(root, "packages/butler-app/client/ui"));
    const dev = await createServer({ logLevel: "error",
      plugins: [{ name: "image-baseline", enforce: "pre", load(id) { return sources.get(id.split("?")[0]); } }],
      server: { host: "127.0.0.1", port: 0, proxy: {
        "^/(?!$|src/|@|node_modules/|assets/|.*\\.(?:tsx?|jsx?|css|svg|woff2?|png|ico|html)(?:\\?|$))": {
          target: server.url, changeOrigin: true,
          configure(proxy) { proxy.on("proxyReq", request => request.setHeader("origin", new URL(server.url).origin)); },
        },
      } } });
    await dev.listen(); process.chdir(root); vite = dev; base = dev.resolvedUrls!.local[0];
  }
  const key = await server.api<{ credential: { id: string } }>("/credentials", { method: "POST", body: JSON.stringify({ provider_id: "openai", api_key: "image-smoke-key" }) });
  const settings = await server.api<{ models: Array<{ model_ref: string; display_name: string; provider_id: string; default_quality: string }> }>("/settings/image-model");
  const model = settings.models.find(model => model.provider_id === "openai")!;
  assert(model); assert(settings.models.length >= 2);
  await server.api("/settings/image-model", { method: "PUT", body: JSON.stringify({ model_ref: model.model_ref, credential_id: key.credential.id, default_quality: model.default_quality }) });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", access_mode: "auto", appearance_theme: theme, wallpaper: { source: { kind: "none" } } }) });
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference", colorScheme: theme as "light" | "dark" });
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", async response => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 404 && path.endsWith("/output")) missingOutput = path + new URL(response.url()).search;
    if (response.status() >= 400 && (path.startsWith("/message-assets/") || path.endsWith("/output")))
      console.log(JSON.stringify({ imageRequest: path, status: response.status(), code: (await response.json().catch(() => ({}))).error?.code }));
  });
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/session-view") lastSession = url.searchParams.get("session_id"); });
  await server.signIn(page);
  await page.route("**/settings/image-model", async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(base).origin } });
    if (route.request().method() !== "GET") { await route.fulfill({ response }); return; }
    const body = await response.json();
    assert(response.ok() && Array.isArray(body.data?.models), `image settings HTTP ${response.status()}: ${body.error?.code ?? Object.keys(body).join(",")}`);
    for (const model of body.data.models) if (model.provider_id === "openai") model.credentials.push({ id: "chatgpt_oauth", label: "ChatGPT", auth_type: "chatgpt_oauth", selectable: false, masked_value: "" });
    await route.fulfill({ response, json: body });
  });
  await page.goto(base);
  await page.locator('[contenteditable="true"]').waitFor();
  await openModels(page);
  {
    const section = page.locator('[data-settings-section-id="image-models"]');
    const select = section.getByRole("combobox");
    await select.nth(0).click();
    assert.equal(await page.getByRole("option").count(), settings.models.length + 1);
    await page.keyboard.press("Escape");
    await select.nth(1).click();
    const signin = page.getByRole("option", { name: "ChatGPT", exact: true });
    assert.equal(await signin.getAttribute("aria-disabled"), "true");
    await signin.hover(); await page.getByRole("tooltip").filter({ hasText: "API 키 전용" }).waitFor();
    await capture(page, "settings-credential-1280");
    await page.keyboard.press("Escape");
    await select.nth(2).click(); await page.getByRole("option", { name: "낮음", exact: true }).click();
    await page.reload(); await openModels(page); await section.waitFor();
    assert.equal((await server.api<{ selected: { default_quality: string } }>("/settings/image-model")).selected.default_quality, "low");
  }
  console.log(`image tools (${theme}): settings saved and reloaded`);
  const imageSection = page.locator('[data-settings-section-id="image-models"]');
  await imageSection.scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await captureResponsive(page, "settings");
  await page.keyboard.press("Escape");
  if (!(await page.locator('[contenteditable="true"]').isVisible())) {
    await page.goto(base); await page.locator('[contenteditable="true"]').waitFor();
  }
  call = { name: "generate_image", arguments: { prompt: "Create a blue picture" } };
  await send(page, requestTitle);
  const card = page.locator('[data-test-class="generated-image-card"]').first();
  {
    await card.waitFor();
    const picture = card.locator("img");
    await picture.evaluate((image: HTMLImageElement) => image.decode());
    const frame = card.locator('[data-slot="media-frame"]');
    const bounds = (await frame.boundingBox())!;
    assert(bounds.width > 100 && bounds.height > 100, "inline media is not collapsed");
    assert.equal(await frame.getAttribute("data-aspect"), "16:10", "3:2 maps to closest supported aspect");
    const image = new URL((await picture.getAttribute("src"))!, base).pathname.split("/").at(-1)!;
    assert(image.startsWith("img_"));
    console.log(`image tools (${theme}): inline card ${Math.round(bounds.width)}×${Math.round(bounds.height)}`);
    assert.equal(await picture.getAttribute("alt"), pictureTitle);
    await captureResponsive(page, "reply");
    await librarySave(page, image);
    const downloaded = page.waitForEvent("download"); await card.getByRole("button", { name: "다운로드", exact: true }).click();
    assert((await downloaded).suggestedFilename().startsWith(image));
    await card.getByRole("button").first().click();
    const viewer = page.locator('[data-slot="image-viewer"]'); await viewer.waitFor();
    await viewer.getByRole("button", { name: "확대", exact: true }).click();
    assert.equal(await viewer.locator("img").getAttribute("data-zoomed"), "");
    await viewer.getByRole("button", { name: "축소", exact: true }).click();
    assert.equal(await viewer.locator("img").getAttribute("data-zoomed"), null);
    for (const name of ["편집", "서랍에 저장", "다운로드"]) assert.equal(await viewer.getByRole("button", { name, exact: true }).count(), 1);
    const viewerDownload = page.waitForEvent("download"); await viewer.getByRole("button", { name: "다운로드", exact: true }).click();
    assert((await viewerDownload).suggestedFilename().startsWith(image));
    if (!before) assert.equal(await viewer.locator('[data-slot="tinted-glass"]').count(), 1, "generated viewer only has the action capsule, no caption");
    await captureResponsive(page, "viewer");
    await viewer.getByRole("button", { name: "편집", exact: true }).click();
    const editor = page.locator('[data-test-class="image-editor"]'); await editor.waitFor();
    await capture(page, "editor-open-1280");
    const editorNode = await editor.elementHandle();
    const pane = page.locator('[data-slot="adaptive-shell-split-pane"]');
    const paneNode = await pane.elementHandle();
    await editor.getByRole("button", { name: "지우개", exact: true }).click();
    assert.equal(await editor.getByRole("button", { name: "지우개", exact: true }).getAttribute("aria-pressed"), "true");
    await editor.focus(); await page.keyboard.press("b");
    assert.equal(await editor.getByRole("button", { name: "브러시", exact: true }).getAttribute("aria-pressed"), "true");
    await paint(page);
    assert(await editor.getByRole("button", { name: "실행 취소", exact: true }).isEnabled());
    await editor.focus(); await page.keyboard.press("ControlOrMeta+z");
    assert(await editor.getByRole("button", { name: "실행 취소", exact: true }).isDisabled());
    await paint(page);
    provider.hold();
    call = { name: "edit_image", arguments: { image, prompt: "Make this region orange" } };
    const posted = page.waitForRequest(request => new URL(request.url()).pathname === "/messages" && request.method() === "POST");
    const mask = page.waitForResponse(response => new URL(response.url()).pathname === "/message-assets/masks");
    await editor.getByRole("textbox").fill("칠한 곳을 주황색으로 바꿔 주세요");
    await editor.getByRole("button", { name: "보내기", exact: true }).click();
    const sent = (await posted).postDataJSON(); const uploaded = await mask;
    assert(uploaded.ok()); const stored = (await uploaded.json()).data;
    assert.deepEqual(sent.image_edit, { image, mask: stored.id });
    await editor.locator('[data-generating]').waitFor();
    assert(await editor.evaluate((node, previous) => node === previous, editorNode), "editor DOM node survives send");
    assert(await pane.evaluate((node, previous) => node === previous, paneNode), "pane DOM node survives send");
    assert.deepEqual(await pane.evaluate(node => node.getAnimations().filter(a => a.playState === "running").map(a => (a as CSSAnimation).animationName)), [], "sending does not replay pane entry");
    assert(await editor.getByRole("button", { name: "보내기", exact: true }).isDisabled());
    assert.equal(await editor.locator('[data-slot="spinner"]').count(), 1);
    const shimmer = editor.locator('[data-generating] > div[aria-hidden="true"]').first();
    await shimmer.waitFor();
    assert((await shimmer.evaluate(node => getComputedStyle(node).maskImage)).startsWith("url("));
    assert.notEqual(await shimmer.evaluate(node => getComputedStyle(node, "::after").animationName), "none");
    await capture(page, "editor-generating-1280");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await shimmer.evaluate(node => getComputedStyle(node, "::after").animationName), "none");
    provider.release();
    await editor.getByRole("button", { name: "버전 2", exact: true }).waitFor();
    await editor.locator('[data-generating]').waitFor({ state: "detached" });
    assert.equal(await editor.getByRole("button", { name: "버전 2", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await editor.getByRole("button", { name: "버전 2", exact: true }).getAttribute("data-selected"), "true");
    assert(await editor.getByRole("button", { name: "실행 취소", exact: true }).isDisabled());
    const resultPicture = editor.getByRole("img", { name: "이미지 편집", exact: true }).locator(":scope > img").first();
    const versionPath = async (n: number) => new URL((await editor.getByRole("button", { name: `버전 ${n}`, exact: true }).locator("img").getAttribute("src"))!, base).pathname;
    const resultPath = await versionPath(2);
    const canvasPath = async () => new URL((await resultPicture.getAttribute("src"))!, base).pathname;
    assert.equal(await canvasPath(), resultPath, "revealed canvas source belongs to selected version 2");
    assert(resultPath !== `/message-assets/${image}`, "edit creates a distinct version");
    await editor.getByRole("button", { name: "원본", exact: true }).hover(); await page.mouse.down();
    await page.waitForFunction(id => document.querySelector('[data-test-class="image-editor"] [role="img"] > img')?.getAttribute("src")?.includes(`/message-assets/${id}?`), image);
    await page.mouse.up();
    await page.waitForFunction(path => { const src = document.querySelector('[data-test-class="image-editor"] [role="img"] > img')?.getAttribute("src"); return src && new URL(src, location.href).pathname === path; }, resultPath);
    await editor.getByRole("button", { name: "버전 1", exact: true }).click();
    await page.waitForFunction(id => document.querySelector('[data-test-class="image-editor"] [role="img"] > img')?.getAttribute("src")?.includes(`/message-assets/${id}?`), image);
    assert.equal(await canvasPath(), await versionPath(1), "picked version 1 is the canvas source");
    await editor.getByRole("button", { name: "버전 2", exact: true }).click();
    await page.waitForFunction(path => { const src = document.querySelector('[data-test-class="image-editor"] [role="img"] > img')?.getAttribute("src"); return src && new URL(src, location.href).pathname === path; }, resultPath);
    assert.equal(await canvasPath(), await versionPath(2), "picked version 2 is the canvas source");
    console.log(`image tools (${theme}): masked edit revealed`);
    await capture(page, "editor-result-1280");
    await editor.focus();
    const focus = await auditTabOrder(page, { within: '[data-test-class="image-editor"]', maxStops: 20 });
    assert(focus.stops > 5); assert.deepEqual(focus.clipped, []);
    console.log(JSON.stringify({ editorFocusStops: focus.stops, clips: focus.clipped.length }));
    await setAccess(page, "읽기 전용");
    await editor.getByRole("textbox").fill("읽기 전용에서도 칠할 수 있어요");
    assert(await editor.getByRole("button", { name: "보내기", exact: true }).isDisabled());
    await paint(page);
    assert(await editor.getByRole("button", { name: "실행 취소", exact: true }).isEnabled());
    await capture(page, "editor-read-only-1280");
    await setAccess(page, "알아서 진행");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-test-class="image-editor"]')?.getBoundingClientRect();
      return box && box.width >= 370 && box.height >= 700;
    });
    const box = (await editor.boundingBox())!;
    assert(box.width >= 370 && box.height >= 700, "mobile editor fills the workspace below the titlebar");
    console.log(JSON.stringify({ mobileEditor: { width: Math.round(box.width), height: Math.round(box.height) } }));
    assert.equal(await page.locator('[contenteditable="true"]').count(), 0, "mobile editor replaces the chat");
    if (!before) {
      assert.equal(await canvasPath(), resultPath, "mobile canvas retains the selected result");
      assert.equal(await editor.getByRole("button", { name: "버전 2", exact: true }).getAttribute("aria-pressed"), "true");
    }
    await capture(page, "editor-390");
    await editor.getByRole("button", { name: "브러시 크기", exact: true }).click();
    await page.getByRole("slider", { name: "브러시 크기", exact: true }).waitFor();
    assert.equal(await page.locator('[data-slot="popover-content"][data-presentation="sheet"]').count(), 1);
    await page.keyboard.press("Escape");
    await editor.focus();
    const mobileFocus = await auditTabOrder(page, { within: '[data-test-class="image-editor"]', maxStops: 20 });
    assert(mobileFocus.stops > 5); assert.deepEqual(mobileFocus.clipped, []);
    console.log(JSON.stringify({ mobileEditorFocusStops: mobileFocus.stops, clips: mobileFocus.clipped.length }));
    await editor.getByRole("button", { name: "닫기", exact: true }).click();
    await page.locator('[contenteditable="true"]').waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await setAccess(page, "먼저 확인");
    await page.reload(); await card.waitFor();
    call = { name: "edit_image", arguments: { image, prompt, size: "1024x1024", quality: "high" } };
    await send(page, "이 그림을 편집해 주세요");
    const approval = page.locator('[data-test-class="composer-authority-decision"]'); await approval.waitFor();
    for (const fact of ["모델", model.display_name, "크기", "품질", "높음", "프롬프트", "1024x1024", prompt.trim()])
      assert((await approval.innerText()).includes(fact), `approval contains complete fact: ${fact.slice(0, 30)}`);
    await approval.locator("img").first().waitFor(); await captureResponsive(page, "approval");
    await approval.getByRole("button", { name: "거절", exact: true }).click();
    await approval.waitFor({ state: "detached" });
    await setAccess(page, "읽기 전용");
    await page.reload(); await card.waitFor();
    assert(await card.getByRole("button", { name: "편집", exact: true }).isDisabled());
    await server.api("/settings/image-model", { method: "PUT", body: JSON.stringify({ selected: null }) });
    await setAccess(page, "알아서 진행");
    await page.reload(); await card.waitFor();
    const edit = page.locator('[data-test-class="generated-image-card"]').last().getByRole("button", { name: "편집", exact: true });
    assert(await edit.isDisabled());
    await edit.scrollIntoViewIfNeeded(); await page.mouse.move(1100, 24);
    await page.waitForFunction(() => !document.querySelector('[data-left-peek="true"]'));
    await edit.hover(); await page.getByRole("tooltip").filter({ hasText: "이미지 모델 없음" }).waitFor();
    assert.equal(provider.requests.filter(r => r.path.endsWith("edits")).length, 1);
    await libraryPreview(page, image);
  }
  if (!before && !Bun.argv.includes("--dev") && theme === "light") await verifyImageToolsElectron(join(output!, "electron"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, stage: before ? "before" : "after", theme, imageCalls: provider.requests.length, screenshots: output }));
} catch (error) {
  console.log(JSON.stringify({ providerCalls: provider.requests.length, scriptedCallPending: Boolean(call), errors }));
  if (lastSession) {
    const view = await server.api<{ latest_turn?: { state: string }; messages?: Array<{ role: string; status: string; turn_activity_rows?: Array<{ safe_tool_name?: string; state: string; tool_result_id?: string }> }> }>(`/session-view?session_id=${encodeURIComponent(lastSession)}`);
    console.log(JSON.stringify({ state: view.latest_turn?.state, messages: view.messages?.map(message => ({ role: message.role, status: message.status, rows: message.turn_activity_rows?.map(row => ({ tool: row.safe_tool_name, state: row.state, result: Boolean(row.tool_result_id) })) })) }));
  }
  if (missingOutput) console.log({ missingOutputNowReadable: await server.api(missingOutput).then(() => true, () => false) });
  const failed = browser?.contexts()[0]?.pages()[0];
  if (failed) await failed.screenshot({ path: join(output!, `failure-${before ? "before" : "after"}-${theme}.png`) }).catch(() => {});
  throw error;
} finally { provider.release(); await browser?.close(); await vite?.close(); await server.stop(); provider.server.stop(true); }
