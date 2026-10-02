import { launchSmokeBrowser } from "../support/browser-launch.ts";
/**
 * Conversation DS story smoke: work progress rows, the current-status line,
 * reply inline images and attachments, checked on DS Viewer showcase stories
 * via deep links (`?visual=design-system&page=<entry>`).
 *
 * These assertions lived in app-layout-smoke, driven by progress rows and
 * artifact files that the retired in-process TypeScript responder injected.
 * The native gateway has no injection hook, so the rendering contract is now
 * checked on the DS blocks the conversation composes (WorkActivityBlock,
 * RollingStatusLine, MarkdownContent, AttachmentList); app-layout-smoke keeps
 * the real turn against the native gateway.
 *
 * Needs a built UI (`npm --prefix packages/butler-app/client/ui run build`).
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Locator, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const root = process.cwd();
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const screenshotDir = resolve(root, ".tmp", "ds-conversation-stories");
mkdirSync(screenshotDir, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openStory(page: Page, baseUrl: string, entry: string, story: string, width = "app"): Promise<Locator> {
  const params = new URLSearchParams({ visual: "design-system", page: entry, theme: "light", locale: "en", width });
  await page.goto(`${baseUrl}?${params.toString()}`, { waitUntil: "networkidle" });
  const scope = page.locator(`[data-ds-story="${story}"]`).first();
  await scope.waitFor({ state: "visible" });
  await scope.scrollIntoViewIfNeeded();
  return scope;
}

async function tokenColor(scope: Locator, token: string): Promise<string> {
  return await scope.evaluate((element, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    element.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function checkWorkActivity(page: Page, baseUrl: string): Promise<void> {
  const story = await openStory(page, baseUrl, "blocks/WorkActivityBlock", "Running and done");
  const block = story.locator("[data-test-class~='turn-work-block']").last();
  await block.waitFor({ state: "visible" });
  assert(await story.locator("[data-test-class~='turn-work-block-running']").count() > 0, "running work block state is missing");
  const secondary = await tokenColor(block, "--text-secondary");
  const muted = await tokenColor(block, "--work-activity-muted-text");
  const state = await block.evaluate((element) => {
    const header = element.querySelector("[data-test-class~='turn-work-block-header']");
    const marker = element.querySelector("[data-slot='work-activity-marker']");
    const description = element.querySelector("[data-slot='work-activity-description']");
    const toolRow = element.querySelector("[data-test-class~='turn-work-tool-row']");
    const tool = toolRow?.querySelector("button") ?? null;
    const box = (node: Element | null | undefined) => node?.getBoundingClientRect() ?? null;
    const style = (node: Element | null | undefined) => (node ? getComputedStyle(node) : null);
    return {
      background: getComputedStyle(element).backgroundColor,
      hasHeaderIcon: Boolean(element.querySelector("[data-slot='work-activity-icon'] svg")),
      markerSize: box(marker)?.width ?? 0,
      headerX: box(header)?.x ?? Number.NaN,
      descriptionX: box(description)?.x ?? Number.NaN,
      toolX: box(toolRow)?.x ?? Number.NaN,
      titleWeight: style(header)?.fontWeight ?? "",
      titleWhiteSpace: style(header)?.whiteSpace ?? "",
      titleColor: style(header)?.color ?? "",
      descriptionColor: style(description)?.color ?? "",
      toolColor: style(tool)?.color ?? "",
      toolDisplay: style(tool)?.display ?? "",
      toolAlign: style(tool)?.alignItems ?? "",
      toolBorderWidth: style(tool)?.borderTopWidth ?? "",
      toolBorderColor: style(tool)?.borderTopColor ?? "",
      toolMaxWidth: style(tool)?.maxWidth ?? "",
      toolCursor: style(tool)?.cursor ?? "",
    };
  });
  const detail = JSON.stringify(state);
  assert(/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/u.test(state.background), `completed work block should stay visually plain: ${detail}`);
  assert(Number(state.titleWeight) <= 500, `work timeline title should not be bold: ${detail}`);
  assert(state.titleWhiteSpace === "normal", `work timeline title should wrap: ${detail}`);
  assert(state.titleColor === secondary && state.descriptionColor === muted && state.toolColor === muted,
    `work timeline text should step down to secondary and muted tones: ${detail}`);
  assert(state.descriptionColor !== state.titleColor, `work timeline body should be quieter than its title: ${detail}`);
  assert(!state.hasHeaderIcon && state.markerSize >= 6, `work timeline should use a dot marker, not a header icon: ${detail}`);
  assert(Math.abs(state.headerX - state.descriptionX) <= 1 && Math.abs(state.headerX - state.toolX) <= 1,
    `work timeline content starts should align: ${detail}`);
  assert(state.toolDisplay === "grid" && state.toolAlign === "center" && state.toolBorderWidth === "1px" &&
    state.toolMaxWidth !== "none" && state.toolBorderColor !== "rgba(0, 0, 0, 0)" && state.toolCursor === "pointer",
  `tool row should be an outlined, capped, center-aligned pointer button: ${detail}`);

  // Several tools collapse into one counted summary ("1 Search, 1 Bash");
  // keyboard Enter opens it, and each operation row opens its own details.
  const group = block.locator("[data-test-class~='turn-work-tool-group'] > button").first();
  const summary = (await group.innerText()).replace(/\s+/gu, " ").trim();
  assert(/\bBash\b/u.test(summary) && /\d/u.test(summary), `tool group should summarize counted operations: ${summary}`);
  await group.focus();
  await page.keyboard.press("Enter");
  assert(await group.getAttribute("aria-expanded") === "true", "tool group keyboard Enter expands its operations");
  const bashRow = block.locator("[data-test-class~='turn-work-tool-detail-row']", { hasText: "Bash:" }).first();
  const bash = bashRow.locator("button").first();
  await bash.waitFor({ state: "visible" });
  const bashLabel = (await bash.innerText()).replace(/\s+/gu, " ").trim();
  assert(bashLabel === "Bash: env | grep -Ei \"CODEX|GEMMA\"", `tool row should show its operation label: ${bashLabel}`);
  await bash.focus();
  await page.keyboard.press("Enter");
  assert(await bash.getAttribute("aria-expanded") === "true", "tool row keyboard Enter expands details");
  const details = bashRow.locator("[data-test-class~='turn-work-tool-detail-text']").first();
  await details.waitFor({ state: "visible" });
  const detailColor = await details.evaluate((element) => getComputedStyle(element).color);
  assert(detailColor === muted, `tool details should use the muted work tone: ${detailColor} vs ${muted}`);
  await story.screenshot({ path: join(screenshotDir, "work-activity.png"), animations: "disabled" });
}

async function checkInlineDisclosure(page: Page, baseUrl: string): Promise<void> {
  // TurnActivityTimeline's history disclosure is a Button variant="inline".
  const story = await openStory(page, baseUrl, "components/Button", "Inline");
  const button = story.locator("[data-ds-theme] button").first();
  const rest = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };
  });
  assert(rest.paddingLeft === "0px" && rest.paddingRight === "0px", `inline disclosure should have no inline padding: ${JSON.stringify(rest)}`);
  await button.hover();
  await page.waitForTimeout(250);
  const hover = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, textDecoration: style.textDecorationLine };
  });
  assert(hover.background === rest.background && hover.textDecoration.includes("underline"),
    `inline disclosure hover should underline without a surface: ${JSON.stringify({ rest, hover })}`);
}

async function checkCurrentStatusLine(page: Page, baseUrl: string): Promise<void> {
  const story = await openStory(page, baseUrl, "components/RollingStatusLine", "Long status truncates");
  const geometry = await story.locator("[data-ds-theme] p").first().evaluate((line) => {
    const slot = line.parentElement?.parentElement ?? line;
    const original = line.textContent;
    const beforeHeight = slot.getBoundingClientRect().height;
    line.textContent = "A deliberately long current operation label ".repeat(20);
    const afterHeight = slot.getBoundingClientRect().height;
    const clipped = line.scrollWidth > line.clientWidth;
    line.textContent = original;
    return { beforeHeight, afterHeight, clipped };
  });
  assert(Math.abs(geometry.beforeHeight - geometry.afterHeight) < 0.5 && geometry.clipped,
    `current status must stay one clipped line: ${JSON.stringify(geometry)}`);
}

async function checkInlineImage(page: Page, baseUrl: string): Promise<void> {
  for (const width of ["375", "app"]) {
    const story = await openStory(page, baseUrl, "blocks/MarkdownContent", "Inline image", width);
    const image = story.locator("[data-ds-theme] img").first();
    await image.waitFor({ state: "visible" });
    const state = await image.evaluate(async (element) => {
      const img = element as HTMLImageElement;
      if (!img.complete) await new Promise((done) => { img.addEventListener("load", done, { once: true }); setTimeout(done, 1200); });
      const documentBox = img.parentElement?.parentElement?.getBoundingClientRect();
      return { complete: img.complete, naturalWidth: img.naturalWidth, width: img.getBoundingClientRect().width, documentWidth: documentBox?.width ?? 0 };
    });
    assert(state.complete && state.naturalWidth > 0 && state.width > 0 && state.width <= state.documentWidth * 0.31,
      `markdown inline image should load and stay bounded (${width}): ${JSON.stringify(state)}`);
    if (width === "375") await story.screenshot({ path: join(screenshotDir, "inline-image-375.png"), animations: "disabled" });
  }
}

async function checkAttachments(page: Page, baseUrl: string): Promise<void> {
  const list = await openStory(page, baseUrl, "blocks/AttachmentList", "Message attachments (list)");
  const listState = await list.locator("[data-ds-theme]").first().evaluate((element) => {
    const images = [...element.querySelectorAll("img")] as HTMLImageElement[];
    return { links: element.querySelectorAll("a[href]").length, thumbnails: images.filter((img) => img.complete && img.naturalWidth > 0).length };
  });
  assert(listState.links >= 2 && listState.thumbnails >= 1, `message attachments should list files with a thumbnail: ${JSON.stringify(listState)}`);

  const chips = await openStory(page, baseUrl, "blocks/AttachmentList", "Composer chips (removable)", "375");
  const chipState = await chips.locator("[data-ds-theme]").first().evaluate((frame) => {
    const texts = [...frame.querySelectorAll<HTMLElement>("*")].filter((node) =>
      node.children.length === 0 && node.textContent?.includes("a-very-long-image-file-name"));
    const truncated = texts.some((node) => node.scrollWidth > node.clientWidth + 1);
    return {
      removeButtons: frame.querySelectorAll("button").length,
      overflow: frame.scrollWidth - frame.clientWidth,
      truncated,
    };
  });
  assert(chipState.removeButtons >= 4, `composer chips should each offer remove: ${JSON.stringify(chipState)}`);
  assert(chipState.overflow <= 1, `composer chips should wrap inside 375px: ${JSON.stringify(chipState)}`);
  assert(chipState.truncated, `long attachment names should truncate: ${JSON.stringify(chipState)}`);
  await chips.screenshot({ path: join(screenshotDir, "attachment-chips-375.png"), animations: "disabled" });
}

const server = await createNativeAppServer({ uiRoot });
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await server.signIn(page);
  await checkWorkActivity(page, server.url);
  await checkInlineDisclosure(page, server.url);
  await checkCurrentStatusLine(page, server.url);
  await checkInlineImage(page, server.url);
  await checkAttachments(page, server.url);
  console.log(JSON.stringify({
    ok: true,
    service: "butler-ds-conversation-stories-smoke",
    checks: [
      "work-block-plain-surface", "work-title-weight-wrap-tone", "work-dot-marker", "work-content-starts-align",
      "tool-row-outlined-capped-pointer", "tool-group-counted-summary", "tool-row-operation-label", "tool-rows-keyboard-expand", "tool-details-muted", "inline-disclosure-unpadded-underline-hover",
      "current-status-one-clipped-line", "markdown-inline-image-bounded", "message-attachments-thumbnail",
      "composer-chips-wrap-truncate-remove",
    ],
    screenshots: screenshotDir,
    stubModelCalls: server.stubModelCalls.length,
  }));
} finally {
  await browser.close();
  await server.stop();
}
