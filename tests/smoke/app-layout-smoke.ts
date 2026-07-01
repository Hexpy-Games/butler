import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import {
  readFirstChatOnboardingState,
  writeFirstChatOnboardingState,
} from "../../packages/butler-agent/src/personalization/onboarding.ts";
import {
  clientTurnIdFromMessageId,
  mergeSessionSummaryForPendingTurn,
} from "../../packages/butler-app/client/ui/src/app/utils.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import {
  FIRST_RUN_STORAGE_KEY,
  firstRunCompleteState,
} from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import type { SessionSummaryView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const root = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "butler-app-layout-smoke-"));
writeFirstChatOnboardingState(tempDir, {
  ...readFirstChatOnboardingState(tempDir),
  status: "complete",
  completed_at: new Date().toISOString(),
});
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const screenshotDir = resolve(root, ".tmp", "app-layout-smoke");
mkdirSync(screenshotDir, { recursive: true });
const rightPanelToggleSelector = `[aria-label="${appCopy.titlebar.showRightPanel}"], [aria-label="${appCopy.titlebar.hideRightPanel}"]`;
const turnActivityTimeoutMs = 3_000;
const testClass = (name: string) => `[data-test-class~="${name}"]`;
const testClasses = (...names: string[]) => names.map(testClass).join("");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function screenshot(page: Page, name: string): Promise<string> {
  const path = join(screenshotDir, name);
  await page.screenshot({ path, fullPage: false });
  const stats = statSync(path);
  assert(stats.size > 8_000, `screenshot is unexpectedly small: ${name}`);
  return `.tmp/app-layout-smoke/${name}`;
}

async function expectLocatorCount(
  page: Page,
  selector: string,
  count: number,
  message: string,
): Promise<void> {
  const actual = await page.locator(selector).count();
  assert(actual === count, `${message}: expected ${count}, got ${actual}`);
}

async function patchSettings(settings: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${server.url}settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  const body = await response.json().catch(() => null);
  assert(
    response.ok,
    `settings patch failed: ${response.status} ${JSON.stringify(body)}`,
  );
}

async function clickConversationAwayFromMenus(page: Page): Promise<void> {
  const box = await page.locator(testClass("conversation")).boundingBox();
  assert(box, "conversation area is missing");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function closeBlockingOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const overlayCount = await page
      .locator('[role="presentation"]')
      .evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return (
              style.position === "fixed" &&
              box.width >= window.innerWidth * 0.8 &&
              box.height >= window.innerHeight * 0.8
            );
          }).length,
      );
    if (overlayCount === 0) return;
    await page.keyboard.press("Escape");
    await page.mouse.click(8, 8);
    await page.waitForTimeout(160);
  }
}

async function assertComposerHoverPill(
  page: Page,
  selector: string,
  label: string,
): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.hover();
  await page.waitForTimeout(80);
  const shape = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderTopLeftRadius,
      height: box.height,
      overflow: style.overflow,
    };
  });
  const radius = parseFloat(shape.borderRadius);
  assert(
    Number.isFinite(radius) && radius >= shape.height / 2 - 0.5,
    `${label} hover highlight should have pill/circle radius: ${JSON.stringify(shape)}`,
  );
  assert(
    shape.overflow === "hidden",
    `${label} hover highlight should clip to the pill/circle shape: ${JSON.stringify(shape)}`,
  );
  assert(
    shape.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      shape.backgroundColor !== "transparent",
    `${label} hover highlight should render a non-transparent background: ${JSON.stringify(shape)}`,
  );
}

assert(
  existsSync(join(uiRoot, "index.html")),
  "UI dist is missing; run app UI build first.",
);

const pendingSummary: SessionSummaryView = {
  session_id: "smoke-session",
  turn_state: "thinking",
  latest_progress: {
    turn_id: clientTurnIdFromMessageId("smoke-client-message"),
    state: "thinking",
    safe_progress_rows: [
      {
        id: "pending-thinking",
        kind: "thinking",
        state: "thinking",
        safe_label: "Thinking",
      },
    ],
  },
};
const inlineSmokeImageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
let releaseSmokeResponderReply: (() => void) | undefined;
let releaseSmokeResponderProgress: (() => void) | undefined;
const smokeResponderProgressGate = new Promise<void>((resolveGate) => {
  releaseSmokeResponderProgress = resolveGate;
});
const smokeResponderReplyGate = new Promise<void>((resolveGate) => {
  releaseSmokeResponderReply = resolveGate;
});
const staleSummary: SessionSummaryView = {
  session_id: "smoke-session",
  turn_state: "delivered",
  latest_progress: {
    turn_id: "previous-turn",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "stale-command",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: stale command",
      },
    ],
  },
};
assert(
  mergeSessionSummaryForPendingTurn(pendingSummary, staleSummary)
    .latest_progress?.safe_progress_rows[0]?.safe_label === "Thinking",
  "pending-turn-does-not-flash-stale-tool-history",
);

const server = createAppServer({
  dbPath: join(tempDir, "layout-smoke.sqlite"),
  butlerData: tempDir,
  uiRoot,
  port: 0,
  bridgeMode: "external",
  responder: async (input) => {
    await smokeResponderProgressGate;
    input.onProgress?.({
      id: "smoke-progress-command",
      kind: "ran_command",
      safe_label: "Bash: bun test",
      safe_tool_name: "Bash",
      safe_input_label: "bun test",
      work_block_id: "smoke-work-command",
      work_block_label: "로컬 테스트 명령을 실행합니다.",
      state: "running",
      safe_detail_rows: [
        {
          id: "smoke-progress-command-detail",
          kind: "command",
          safe_label: "Command",
          safe_value: "bun test",
          state: "running",
        },
      ],
    });
    await smokeResponderReplyGate;
    return {
      texts: [
        [
          "## Butler reply",
          "",
          "- Markdown rendered",
          `- Received ${input.text.length} chars`,
          "",
          "![Inline smoke](artifacts/inline-smoke.png)",
          "",
          "```ts",
          "const ok = true;",
          "```",
        ].join("\n"),
      ],
      files: [
        {
          name: "artifacts/inline-smoke.png",
          mimeType: "image/png",
          bytes: inlineSmokeImageBytes,
        },
      ],
    };
  },
});
const smokeProject = server.store.createProject({
  source: "scratch",
  display_name: "Desktop client polish",
}).project;
server.store.createSession({
  kind: "project",
  project_id: smokeProject.id,
  session_hint: "butler-client",
  title: "Desktop client polish",
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const firstRunStateJson = JSON.stringify(firstRunCompleteState("en"));
await page.addInitScript(
  ({ key, value }) => {
    window.localStorage.setItem(key, value);
  },
  { key: FIRST_RUN_STORAGE_KEY, value: firstRunStateJson },
);
const screenshots: string[] = [];

try {
  await page.goto(`${server.url}?visual=components`, {
    waitUntil: "networkidle",
  });
  await page.locator(testClass("composer-card")).waitFor({ state: "visible" });
  await page
    .locator(testClass("worker-composer-panel"))
    .waitFor({ state: "visible" });
  await page
    .locator(testClass("assistant-mark-static"))
    .first()
    .waitFor({ state: "visible" });
  await page
    .locator(`${testClass("assistant-mark-live")} canvas`)
    .first()
    .waitFor({ state: "visible" });
  screenshots.push(await screenshot(page, "desktop-components.png"));

  const composerBox = await page
    .locator(testClass("composer-wrap"))
    .boundingBox();
  const composerCardBox = await page
    .locator(testClass("composer-card"))
    .boundingBox();
  const messageListBox = await page
    .locator(testClass("message-list"))
    .boundingBox();
  const userBubbleBox = await page
    .locator(`${testClasses("message", "user")} ${testClass("message-body")}`)
    .first()
    .boundingBox();
  const workerBox = await page
    .locator(testClass("worker-composer-panel"))
    .boundingBox();
  assert(
    composerBox &&
      composerCardBox &&
      messageListBox &&
      userBubbleBox &&
      workerBox,
    "composer, message list, user bubble, or worker panel is missing",
  );
  assert(
    Math.abs(messageListBox.width - composerCardBox.width) <= 1,
    `conversation body width should match composer: body=${messageListBox.width}, composer=${composerCardBox.width}`,
  );
  assert(
    userBubbleBox.width < composerCardBox.width * 0.7,
    `user bubble should size to content before max width, got ${userBubbleBox.width}`,
  );
  const assistantFirstLineAlignment = await page
    .locator(testClasses("message", "assistant"))
    .first()
    .evaluate((article) => {
      const avatar = article.querySelector<HTMLElement>(
        "[data-role='assistant']",
      );
      const body = article.querySelector<HTMLElement>(
        "[data-test-class~='message-body']",
      );
      const firstText =
        body?.querySelector<HTMLElement>(
          "p, h1, h2, h3, li, [data-test-class~='turn-work-block-header']",
        ) ?? body;
      const avatarBox = avatar?.getBoundingClientRect();
      const textBox = firstText?.getBoundingClientRect();
      return {
        avatarCenterY: avatarBox
          ? avatarBox.y + avatarBox.height / 2
          : Number.NaN,
        textCenterY: textBox
          ? textBox.y + Math.min(textBox.height, 28) / 2
          : Number.NaN,
      };
    });
  assert(
    Math.abs(
      assistantFirstLineAlignment.avatarCenterY -
        assistantFirstLineAlignment.textCenterY,
    ) <= 8,
    `assistant avatar should align with the first visible line: ${JSON.stringify(assistantFirstLineAlignment)}`,
  );
  assert(
    workerBox.y >= composerCardBox.y &&
      workerBox.y + workerBox.height <=
        composerCardBox.y + composerCardBox.height,
    `worker panel must sit inside the composer card without pushing it offscreen: worker=${JSON.stringify(workerBox)}, card=${JSON.stringify(composerCardBox)}`,
  );
  assert(
    composerBox.y + composerBox.height <= 890,
    "composer must remain visible inside the viewport",
  );
  const composerGlass = await page
    .locator(testClass("composer-card"))
    .evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundSize: style.backgroundSize,
        borderColor: style.borderTopColor,
        shadow: style.boxShadow,
      };
    });
  assert(
    composerGlass.backdrop.includes("blur"),
    `composer must use backdrop blur, got ${composerGlass.backdrop}`,
  );
  assert(
    /rgba\([^)]*,\s*0\.\d+/u.test(composerGlass.background),
    `composer must use translucent rgba background, got ${composerGlass.background}`,
  );
  assert(
    composerGlass.shadow !== "none",
    "composer must keep glass depth shadow",
  );
  assert(
    (composerGlass.backgroundImage.match(/linear-gradient/gu)?.length ?? 0) >=
      3 && composerGlass.backgroundSize.includes("20px"),
    `composer must use tinted glass fixed-edge gradients, got ${JSON.stringify({
      backgroundImage: composerGlass.backgroundImage,
      backgroundSize: composerGlass.backgroundSize,
    })}`,
  );
  assert(
    composerGlass.borderColor === "rgba(255, 255, 255, 0.65)",
    `light composer glass should use white translucent hairline: ${composerGlass.borderColor}`,
  );
  const composerToolbarSurface = await page
    .locator(testClass("composer-toolbar"))
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderTopColor: style.borderTopColor,
        height: element.getBoundingClientRect().height,
      };
    });
  assert(
    composerToolbarSurface.background === "rgba(0, 0, 0, 0)" &&
      composerToolbarSurface.borderTopColor !== "rgba(0, 0, 0, 0)",
    `composer toolbar should rely on a subtle 1px divider only: ${JSON.stringify(composerToolbarSurface)}`,
  );
  const workerSlotSurface = await page
    .locator(testClass("worker-composer-panel"))
    .evaluate((element) => {
      const panelStyle = getComputedStyle(element);
      return {
        panelBg: panelStyle.backgroundColor,
        borderColor: panelStyle.borderBottomColor,
        missing: false,
      };
    });
  assert(
    !workerSlotSurface.missing &&
      workerSlotSurface.panelBg === "rgba(0, 0, 0, 0)" &&
      workerSlotSurface.borderColor !== "rgba(0, 0, 0, 0)",
    `worker panel should be an embedded composer section with a divider: ${JSON.stringify(workerSlotSurface)}`,
  );
  const workerIdentityLayout = await page
    .locator(testClass("worker-composer-panel"))
    .evaluate((element) => {
      const title = element.querySelector<HTMLElement>(
        "[data-slot='activity-feed-title']",
      );
      const meta = element.querySelector<HTMLElement>(
        "[data-slot='activity-feed-meta']",
      );
      const description = element.querySelector<HTMLElement>(
        "[data-slot='activity-feed-description']",
      );
      const styleFor = (node: HTMLElement | null) =>
        node ? getComputedStyle(node) : null;
      return {
        descriptionFlexShrink: styleFor(description)?.flexShrink ?? "",
        descriptionMinWidth: styleFor(description)?.minWidth ?? "",
        metaFlexShrink: styleFor(meta)?.flexShrink ?? "",
        metaMinWidth: styleFor(meta)?.minWidth ?? "",
        titleFlexShrink: styleFor(title)?.flexShrink ?? "",
        titleMinWidth: styleFor(title)?.minWidth ?? "",
        titleText: title?.innerText ?? "",
        metaText: meta?.innerText ?? "",
      };
    });
  assert(
    workerIdentityLayout.titleFlexShrink === "0" &&
      workerIdentityLayout.metaFlexShrink === "0" &&
      workerIdentityLayout.descriptionFlexShrink !== "0" &&
      workerIdentityLayout.descriptionMinWidth === "0px",
    `worker identity should stay fixed while description compresses: ${JSON.stringify(workerIdentityLayout)}`,
  );
  await page
    .getByRole("button", { name: "Copy assistant response" })
    .last()
    .waitFor({ state: "visible" });
  const assistantFooterText = await page
    .locator(testClass("assistant-footer"))
    .last()
    .innerText();
  const assistantFooterTime = await page
    .locator(`${testClass("assistant-footer")} time`)
    .last()
    .getAttribute("datetime");
  const assistantFooterBox = await page
    .locator(testClass("assistant-footer"))
    .last()
    .boundingBox();
  const assistantMessageBox = await page
    .locator(
      `${testClasses("message", "assistant")}:not(${testClass("turn-activity-message")})`,
    )
    .last()
    .boundingBox();
  const conversationEndBox = await page
    .locator(testClass("message"))
    .last()
    .boundingBox();
  assert(assistantFooterBox, "assistant footer box is missing");
  assert(assistantMessageBox, "assistant message box is missing");
  assert(conversationEndBox, "conversation end box is missing");
  const conversationEndGap =
    workerBox.y - (conversationEndBox.y + conversationEndBox.height);
  assert(
    conversationEndGap >= 8 && conversationEndGap <= 44,
    `conversation end should sit near composer stack, got ${conversationEndGap}px`,
  );
  const workerPanelHeader = page
    .locator(testClass("worker-composer-panel"))
    .getByRole("button")
    .first();
  await workerPanelHeader.click();
  const collapsedWorkerHeaderText = await workerPanelHeader.innerText();
  assert(
    /Worker A Executing: Aligning composer controls/u.test(
      collapsedWorkerHeaderText,
    ),
    `collapsed worker panel header should keep the active summary: ${collapsedWorkerHeaderText}`,
  );
  await workerPanelHeader.click();
  await page.waitForTimeout(160);
  assert(
    assistantFooterText.includes("Worked for") &&
      /\d{2}:\d{2}/u.test(assistantFooterText),
    `assistant footer should show worked duration and time: ${assistantFooterText}`,
  );
  assert(
    Boolean(assistantFooterTime) &&
      Number.isFinite(Date.parse(assistantFooterTime ?? "")),
    `assistant footer should expose semantic datetime: ${assistantFooterTime}`,
  );
  await expectLocatorCount(
    page,
    `${testClass("status-pill")}:visible`,
    0,
    "composer should not render idle ready status",
  );
  const summaryProgressState = await page
    .locator(testClass("summary-progress-panel"))
    .evaluate((panel) => {
      const inspector = panel.closest<HTMLElement>(
        "[data-test-class~='right-inspector']",
      );
      const panelBox = panel.getBoundingClientRect();
      const inspectorBox = inspector?.getBoundingClientRect();
      return {
        inspectorClientWidth: inspector?.clientWidth ?? 0,
        inspectorRight: inspectorBox?.right ?? Number.NaN,
        inspectorScrollWidth: inspector?.scrollWidth ?? 0,
        panelClientWidth: panel.clientWidth,
        panelLeft: panelBox.left,
        panelRight: panelBox.right,
        panelScrollWidth: panel.scrollWidth,
      };
    });
  assert(
    summaryProgressState.panelRight <=
      summaryProgressState.inspectorRight - 0.5 &&
      summaryProgressState.panelScrollWidth <=
        summaryProgressState.panelClientWidth + 1 &&
      summaryProgressState.inspectorScrollWidth <=
        summaryProgressState.inspectorClientWidth + 1,
    `summary Progress panel should stay inside inspector bounds: ${JSON.stringify(summaryProgressState)}`,
  );
  await page
    .getByRole("button", { name: appCopy.composer.contextDetails })
    .hover();
  await page.getByText(/Context window:/u).waitFor({ state: "visible" });
  const contextPopoverGlass = await page
    .locator(testClass("context-popover"))
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
        menuTop: element.getBoundingClientRect().top,
        titlebarSafeTop:
          Number.parseFloat(rootStyle.getPropertyValue("--titlebar-height")) +
          Number.parseFloat(rootStyle.getPropertyValue("--space-sm")),
      };
    });
  assert(
    contextPopoverGlass.background === composerGlass.background &&
      contextPopoverGlass.borderColor === composerGlass.borderColor &&
      contextPopoverGlass.backdrop.includes("blur"),
    `popover-liquid-glass-tokenized failed: ${JSON.stringify(contextPopoverGlass)}`,
  );
  assert(
    contextPopoverGlass.menuTop >= contextPopoverGlass.titlebarSafeTop - 1,
    `context popover should stay below titlebar safe area: ${JSON.stringify(contextPopoverGlass)}`,
  );
  await page
    .getByRole("button", { name: appCopy.composer.contextDetails })
    .click();
  await page
    .getByRole("heading", { name: "Context details" })
    .waitFor({ state: "visible" });
  await page
    .getByRole("img", { name: /Context window/u })
    .waitFor({ state: "visible" });
  await page.setViewportSize({ width: 900, height: 520 });
  await page.waitForTimeout(320);
  await page
    .locator(testClass("context-legend-scroll"))
    .waitFor({ state: "visible" });
  const contextLegendState = await page
    .locator(testClass("context-legend-scroll"))
    .evaluate((scroll) => {
      const firstRow = scroll.querySelector<HTMLElement>(
        "[data-test-class~='context-legend'] [data-test-class~='key-value-row']",
      );
      const swatch = firstRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-swatch']",
      );
      const label = firstRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-label']",
      );
      const value = firstRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-value']",
      );
      const description = firstRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-description']",
      );
      const meta = firstRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-meta']",
      );
      const workingRow = document.querySelectorAll<HTMLElement>(
        "[data-test-class~='context-overview'] [data-test-class~='key-value-row']",
      )[1];
      const workingDescription = workingRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-description']",
      );
      const workingMeta = workingRow?.querySelector<HTMLElement>(
        "[data-test-class~='key-value-meta']",
      );
      const chart = document.querySelector<HTMLElement>(
        '[aria-label="Context window usage chart"]',
      );
      const inspector = scroll.closest<HTMLElement>(
        "[data-test-class~='right-inspector']",
      );
      const scrollBox = scroll.getBoundingClientRect();
      const rowBox = firstRow?.getBoundingClientRect();
      const chartBox = chart?.getBoundingClientRect();
      const inspectorBox = inspector?.getBoundingClientRect();
      const swatchBox = swatch?.getBoundingClientRect();
      const labelBox = label?.getBoundingClientRect();
      const descriptionBox = description?.getBoundingClientRect();
      const metaBox = meta?.getBoundingClientRect();
      const workingDescriptionBox = workingDescription?.getBoundingClientRect();
      const workingMetaBox = workingMeta?.getBoundingClientRect();
      const labelStyle = label ? getComputedStyle(label) : null;
      const valueStyle = value ? getComputedStyle(value) : null;
      return {
        clientHeight: scroll.clientHeight,
        clientWidth: scroll.clientWidth,
        chartRight: chartBox?.right ?? Number.NaN,
        descriptionTop: descriptionBox?.top ?? Number.NaN,
        inspectorRight: inspectorBox?.right ?? Number.NaN,
        labelFontSize: labelStyle?.fontSize ?? "",
        labelCenterY: labelBox ? labelBox.y + labelBox.height / 2 : Number.NaN,
        metaTop: metaBox?.top ?? Number.NaN,
        rowRight: rowBox?.right ?? Number.NaN,
        scrollHeight: scroll.scrollHeight,
        scrollLeft: scroll.scrollLeft,
        scrollRight: scrollBox.right,
        scrollWidth: scroll.scrollWidth,
        scrollbarWidth: getComputedStyle(scroll).scrollbarWidth,
        swatchCenterY: swatchBox
          ? swatchBox.y + swatchBox.height / 2
          : Number.NaN,
        valueFontSize: valueStyle?.fontSize ?? "",
        workingDescriptionBottom: workingDescriptionBox?.bottom ?? Number.NaN,
        workingDescriptionLeft: workingDescriptionBox?.left ?? Number.NaN,
        workingMetaLeft: workingMetaBox?.left ?? Number.NaN,
        workingMetaTop: workingMetaBox?.top ?? Number.NaN,
      };
    });
  assert(
    Math.abs(
      contextLegendState.swatchCenterY - contextLegendState.labelCenterY,
    ) <= 0.5,
    `context legend swatch should align to label row: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    contextLegendState.valueFontSize === contextLegendState.labelFontSize,
    `context legend usage value should match label font size: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    Math.abs(contextLegendState.metaTop - contextLegendState.descriptionTop) <=
      1,
    `context legend percentage should top-align to description: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    contextLegendState.scrollWidth <= contextLegendState.clientWidth + 1 &&
      contextLegendState.scrollLeft === 0,
    `context legend should not create horizontal scroll: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    contextLegendState.workingMetaTop >=
      contextLegendState.workingDescriptionBottom - 0.5 &&
      Math.abs(
        contextLegendState.workingMetaLeft -
          contextLegendState.workingDescriptionLeft,
      ) <= 1,
    `working context compaction copy should stack vertically: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    contextLegendState.scrollHeight > contextLegendState.clientHeight + 8,
    `context legend should own overflow scrolling: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    contextLegendState.scrollbarWidth === "thin" &&
      contextLegendState.rowRight <= contextLegendState.scrollRight - 10,
    `context legend scrollbar should sit outside content: ${JSON.stringify(contextLegendState)}`,
  );
  assert(
    Math.abs(contextLegendState.rowRight - contextLegendState.chartRight) <=
      1.5 &&
      contextLegendState.scrollRight >= contextLegendState.inspectorRight - 1,
    `context legend content should align with overview while scrollbar reaches panel edge: ${JSON.stringify(contextLegendState)}`,
  );
  screenshots.push(await screenshot(page, "context-details-legend-scroll.png"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(320);
  screenshots.push(await screenshot(page, "context-details-chart.png"));
  await page.mouse.move(260, 120);
  await page.locator(testClass("context-popover")).waitFor({ state: "hidden" });

  const toggleBox = await page
    .getByRole("button", { name: "Show sidebar" })
    .boundingBox();
  const browserChromeState = await page
    .locator(testClass("mac-window"))
    .evaluate((root) => {
      const style = getComputedStyle(root);
      return {
        className: root.getAttribute("class") ?? "",
        floatingToggleLeft: style
          .getPropertyValue("--chrome-floating-toggle-left")
          .trim(),
        trafficControlsWidth: style
          .getPropertyValue("--traffic-controls-width")
          .trim(),
      };
    });
  assert(toggleBox, "left sidebar toggle is missing");
  assert(
    browserChromeState.className.includes("browser-chrome") &&
      browserChromeState.trafficControlsWidth === "0px" &&
      browserChromeState.floatingToggleLeft === "0px",
    `browser chrome should not reserve native traffic-light space: ${JSON.stringify(browserChromeState)}`,
  );
  assert(
    toggleBox.x >= 0 && toggleBox.x <= 12,
    `browser left sidebar toggle should sit flush to the window edge, got x=${toggleBox.x}`,
  );
  assert(
    toggleBox.y > 8 && toggleBox.y < 34,
    `left sidebar toggle should sit in titlebar, got y=${toggleBox.y}`,
  );
  const initiallyCollapsedSidebarBox = await page
    .locator(testClass("sidebar-slot"))
    .boundingBox();
  assert(
    initiallyCollapsedSidebarBox && initiallyCollapsedSidebarBox.width <= 2,
    `fresh left sidebar should start collapsed, got ${initiallyCollapsedSidebarBox?.width}`,
  );
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.waitForTimeout(320);
  const sidebarToggleButton = page.getByRole("button", {
    name: "Hide sidebar",
  });
  await sidebarToggleButton.hover();
  await page
    .getByRole("tooltip", { name: "Hide sidebar" })
    .waitFor({ state: "visible" });
  const sidebarTooltipState = await page
    .getByRole("tooltip", { name: "Hide sidebar" })
    .evaluate((element) => {
      const rootStyle = getComputedStyle(document.documentElement);
      const titlebarSafeTop =
        Number.parseFloat(rootStyle.getPropertyValue("--titlebar-height")) +
        Number.parseFloat(rootStyle.getPropertyValue("--space-sm"));
      return {
        titlebarSafeTop,
        tooltipTop: element.getBoundingClientRect().top,
      };
    });
  assert(
    sidebarTooltipState.tooltipTop >= sidebarTooltipState.titlebarSafeTop - 1,
    `tooltip should stay below titlebar safe area: ${JSON.stringify(sidebarTooltipState)}`,
  );
  await page.mouse.move(260, 120);
  await page
    .getByRole("tooltip", { name: "Hide sidebar" })
    .waitFor({ state: "hidden" });
  await sidebarToggleButton.hover();
  await page
    .getByRole("tooltip", { name: "Hide sidebar" })
    .waitFor({ state: "visible" });
  await page.mouse.move(260, 120);

  const searchButton = page.getByRole("button", {
    name: appCopy.sidebar.search,
    exact: true,
  });
  const headerButtonBox = await searchButton.boundingBox();
  const fixedHeaderBox = await page
    .locator(testClass("sidebar-fixed-header"))
    .boundingBox();
  const scrollBox = await page
    .locator(testClass("sidebar-scroll"))
    .boundingBox();
  const sidebarShellBox = await page
    .locator(testClass("app-sidebar"))
    .boundingBox();
  const scrollFrameBox = await page
    .locator(testClass("sidebar-scroll-frame"))
    .boundingBox();
  assert(
    fixedHeaderBox &&
      scrollBox &&
      scrollBox.y >= fixedHeaderBox.y + fixedHeaderBox.height - 1,
    `sidebar direct header should stay outside the scroll region: header=${JSON.stringify(fixedHeaderBox)} scroll=${JSON.stringify(scrollBox)}`,
  );
  assert(
    sidebarShellBox &&
      scrollFrameBox &&
      scrollFrameBox.x >= sidebarShellBox.x &&
      scrollFrameBox.x + scrollFrameBox.width <=
        sidebarShellBox.x + sidebarShellBox.width,
    `sidebar scroll frame must stay inside the sidebar shell: shell=${JSON.stringify(sidebarShellBox)} frame=${JSON.stringify(scrollFrameBox)}`,
  );
  const sidebarSectionBoxes = await page
    .locator(`${testClass("sidebar-scroll")} section`)
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          className: element.className,
          maxWidth: style.maxWidth,
          minWidth: style.minWidth,
          width: box.width,
          x: box.x,
        };
      }),
    );
  assert(
    sidebarSectionBoxes.length > 0,
    "sidebar session sections are missing",
  );
  assert(
    scrollFrameBox &&
      sidebarSectionBoxes.every(
        (box) =>
          box.x >= scrollFrameBox.x - 0.5 &&
          box.x + box.width <= scrollFrameBox.x + scrollFrameBox.width + 0.5,
      ),
    `sidebar sections must not exceed the scroll frame: frame=${JSON.stringify(scrollFrameBox)} sections=${JSON.stringify(sidebarSectionBoxes)}`,
  );
  assert(
    headerButtonBox &&
      sidebarSectionBoxes.every(
        (box) =>
          Math.abs(box.x - headerButtonBox.x) <= 0.5 &&
          Math.abs(box.width - headerButtonBox.width) <= 0.5,
      ),
    `sidebar sections should share the header button side margins: header=${JSON.stringify(headerButtonBox)} sections=${JSON.stringify(sidebarSectionBoxes)}`,
  );
  assert(
    headerButtonBox &&
      scrollFrameBox &&
      scrollFrameBox.x + scrollFrameBox.width >
        headerButtonBox.x + headerButtonBox.width + 6,
    `sidebar scrollbar lane should sit to the right of content: header=${JSON.stringify(headerButtonBox)} frame=${JSON.stringify(scrollFrameBox)}`,
  );
  assert(
    (await page
      .locator(testClass("sidebar-scroll"))
      .getByRole("button", { name: appCopy.sidebar.search, exact: true })
      .count()) === 0,
    "sidebar direct navigation should not be inside the session scroll region",
  );
  const sidebarScrollStyle = await page
    .locator(testClass("sidebar-scroll"))
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        maskImage: style.maskImage,
        maskSize: style.maskSize,
        overflowY: style.overflowY,
        scrollbarColor: style.scrollbarColor,
        scrollbarWidth: style.scrollbarWidth,
      };
    });
  assert(
    sidebarScrollStyle.overflowY === "auto" &&
      sidebarScrollStyle.scrollbarWidth === "thin" &&
      sidebarScrollStyle.maskImage !== "none" &&
      sidebarScrollStyle.maskSize.includes("10px"),
    `sidebar fade mask should preserve the scrollbar gutter: ${JSON.stringify(sidebarScrollStyle)}`,
  );
  const searchBgBefore = await searchButton.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await searchButton.hover();
  await page.waitForTimeout(80);
  const searchBgAfter = await searchButton.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  assert(
    searchBgBefore !== searchBgAfter,
    `sidebar-hover-highlight failed: ${searchBgBefore} -> ${searchBgAfter}`,
  );
  const projectGroupRowBox = await page
    .locator(testClass("project-group-row"))
    .first()
    .boundingBox();
  const projectSessionRowBox = await page
    .locator(testClass("project-session-row"))
    .first()
    .boundingBox();
  assert(
    projectGroupRowBox && projectSessionRowBox,
    "sidebar project rows are missing",
  );
  assert(
    Math.abs(projectGroupRowBox.height - projectSessionRowBox.height) <= 1,
    `sidebar rows should share height: group=${projectGroupRowBox.height}, session=${projectSessionRowBox.height}`,
  );
  const projectSessionRow = page
    .locator(testClass("project-session-row"))
    .first();
  const projectSessionDateBox = await projectSessionRow
    .locator("time")
    .boundingBox();
  assert(
    projectSessionDateBox &&
      projectSessionRowBox.x +
        projectSessionRowBox.width -
        (projectSessionDateBox.x + projectSessionDateBox.width) <=
        12,
    `session date should align to the row trailing edge: row=${JSON.stringify(projectSessionRowBox)} date=${JSON.stringify(projectSessionDateBox)}`,
  );
  await projectSessionRow.hover();
  await page.waitForTimeout(140);
  const projectSessionActionIconBox = await projectSessionRow
    .getByRole("button", { name: appCopy.sessionActions.menuLabel })
    .locator("svg")
    .boundingBox();
  assert(
    projectSessionDateBox &&
      projectSessionActionIconBox &&
      Math.abs(
        projectSessionDateBox.x +
          projectSessionDateBox.width -
          (projectSessionActionIconBox.x + projectSessionActionIconBox.width),
      ) <= 1.5,
    `session date and hover action icon should share trailing edge: date=${JSON.stringify(projectSessionDateBox)} icon=${JSON.stringify(projectSessionActionIconBox)}`,
  );
  assert(
    Math.abs(projectGroupRowBox.x - projectSessionRowBox.x) <= 1,
    `project sessions should not be indented: group=${projectGroupRowBox.x}, session=${projectSessionRowBox.x}`,
  );
  const groupBg = await page
    .locator(testClass("project-group-row"))
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const sessionBg = await page
    .locator(testClass("project-session-row"))
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  assert(
    groupBg !== sessionBg,
    `project group must not receive active child-session styling: ${groupBg}`,
  );
  assert(
    (await page
      .locator(testClass("project-session-row"))
      .first()
      .getAttribute("aria-current")) === "page",
    "active project session should expose aria-current",
  );
  await page.locator(testClass("project-group-row")).first().click();
  await page.waitForTimeout(240);
  const projectSessionListCollapsed = await page
    .locator(testClass("project-session-list"))
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        gridTemplateRows: style.gridTemplateRows,
        opacity: style.opacity,
        ariaHidden: element.getAttribute("aria-hidden"),
      };
    });
  assert(
    projectSessionListCollapsed.gridTemplateRows === "0px" &&
      Number(projectSessionListCollapsed.opacity) === 0 &&
      projectSessionListCollapsed.ariaHidden === "true",
    `project-row-click-toggles-collapse failed: ${JSON.stringify(projectSessionListCollapsed)}`,
  );
  await page.locator(testClass("project-group-row")).first().click();
  await page.waitForTimeout(240);
  const projectSessionListReopened = await page
    .locator(testClass("project-session-list"))
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        gridTemplateRows: style.gridTemplateRows,
        opacity: style.opacity,
        ariaHidden: element.getAttribute("aria-hidden"),
      };
    });
  assert(
    /^\d+(\.\d+)?px$/u.test(projectSessionListReopened.gridTemplateRows) &&
      Number(projectSessionListReopened.opacity) === 1 &&
      projectSessionListReopened.ariaHidden === "false",
    `project-row-click-reopens failed: ${JSON.stringify(projectSessionListReopened)}`,
  );
  await page
    .getByRole("button", {
      name: appCopy.sidebar.collapseProjects,
      exact: true,
    })
    .click();
  await page.waitForTimeout(240);
  const projectSessionListAfterCollapseAll = await page
    .locator(testClass("project-session-list"))
    .first()
    .evaluate((element) => ({
      ariaHidden: element.getAttribute("aria-hidden"),
      opacity: getComputedStyle(element).opacity,
    }));
  assert(
    projectSessionListAfterCollapseAll.ariaHidden === "true" &&
      Number(projectSessionListAfterCollapseAll.opacity) === 0,
    `project-collapse-all should close project rows: ${JSON.stringify(projectSessionListAfterCollapseAll)}`,
  );
  await page.locator(testClass("project-group-row")).first().click();
  await page.waitForTimeout(240);
  const projectSessionListAfterIndividualReopen = await page
    .locator(testClass("project-session-list"))
    .first()
    .evaluate((element) => ({
      ariaHidden: element.getAttribute("aria-hidden"),
      opacity: getComputedStyle(element).opacity,
    }));
  assert(
    projectSessionListAfterIndividualReopen.ariaHidden === "false" &&
      Number(projectSessionListAfterIndividualReopen.opacity) === 1,
    `project-row should reopen after collapse-all: ${JSON.stringify(projectSessionListAfterIndividualReopen)}`,
  );
  await page
    .getByRole("button", { name: appCopy.sidebar.newProject, exact: true })
    .click();
  const existingFolderItem = page.getByText(appCopy.sidebar.useExistingFolder);
  await existingFolderItem.waitFor({ state: "visible" });
  const existingFolderAriaDisabled =
    await existingFolderItem.getAttribute("aria-disabled");
  const existingFolderDataDisabled =
    await existingFolderItem.getAttribute("data-disabled");
  assert(
    existingFolderAriaDisabled === "true" ||
      existingFolderDataDisabled !== null,
    `existing-folder action should be disabled without desktop bridge, got aria-disabled=${existingFolderAriaDisabled} data-disabled=${existingFolderDataDisabled}`,
  );
  await expectLocatorCount(
    page,
    `${testClass("composer-error")}:visible`,
    0,
    "disabled project folder picker must not raise composer errors",
  );
  await clickConversationAwayFromMenus(page);
  await page
    .locator('[data-slot="dropdown-menu-content"]')
    .waitFor({ state: "hidden" });
  await expectLocatorCount(
    page,
    '[data-slot="dropdown-menu-content"]:visible',
    0,
    "project add popover should close on outside click",
  );

  await page.locator(testClass("project-group-row")).first().hover();
  await page
    .getByRole("button", { name: appCopy.sidebar.projectDashboard })
    .first()
    .click();
  await page
    .getByRole("heading", { name: /Recent activity/u })
    .waitFor({ state: "visible" });
  await page
    .getByRole("heading", { name: "Plans" })
    .waitFor({ state: "visible" });
  await page
    .getByRole("heading", { name: "Specs" })
    .waitFor({ state: "visible" });
  await page
    .locator("[aria-label='Recent 30 day project activity']")
    .waitFor({ state: "visible" });
  await page
    .locator("[aria-label='Recent 30 day project activity'] span")
    .first()
    .waitFor({ state: "visible" });
  const documentButton = page
    .locator(
      "[data-slot='document-tile'] button, [data-slot='document-tile'][role='button']",
    )
    .first();
  await documentButton.waitFor({ state: "visible" });
  const documentButtonText = await documentButton.innerText();
  assert(
    !/No Project Ledger specs or plans found/iu.test(documentButtonText),
    `project dashboard should expose clickable Project Ledger specs or plans, got ${documentButtonText}`,
  );
  await documentButton.click();
  await page.locator("[role='dialog']").waitFor({ state: "visible" });
  const dialogTopState = await page
    .locator("[role='dialog']")
    .evaluate((node) => {
      const rootStyle = getComputedStyle(document.documentElement);
      const titlebarSafeTop =
        Number.parseFloat(rootStyle.getPropertyValue("--titlebar-height")) +
        Number.parseFloat(rootStyle.getPropertyValue("--space-sm"));
      return {
        dialogTop: node.getBoundingClientRect().top,
        titlebarSafeTop,
      };
    });
  assert(
    dialogTopState.dialogTop >= dialogTopState.titlebarSafeTop - 1,
    `dialog content should stay below titlebar safe area: ${JSON.stringify(dialogTopState)}`,
  );
  await page
    .locator(
      "[role='dialog'] h1, [role='dialog'] h2, [role='dialog'] h3, [role='dialog'] p",
    )
    .first()
    .waitFor({ state: "visible" });
  screenshots.push(await screenshot(page, "project-dashboard-doc-modal.png"));
  await page.keyboard.press("Escape");
  await page.locator("[role='dialog']").waitFor({ state: "hidden" });
  await page
    .locator('[data-slot="dialog-overlay"]')
    .waitFor({ state: "hidden" });
  await closeBlockingOverlays(page);
  await page.locator(testClass("project-session-row")).first().click();
  await page.locator(testClass("conversation")).waitFor({ state: "visible" });

  const leftResize = page.locator(testClass("left-panel-resize-handle"));
  const sidebarWidthBeforeResize =
    (await page.locator(testClass("sidebar-slot")).boundingBox())?.width ?? 0;
  const leftResizeBox = await leftResize.boundingBox();
  assert(leftResizeBox, "left panel resize handle is missing");
  assert(
    (await leftResize.getAttribute("role")) === "separator",
    "left resize handle should expose separator role",
  );
  assert(
    (await leftResize.getAttribute("aria-controls")) === "butler-left-sidebar",
    "left resize handle should control the sidebar",
  );
  assert(
    await leftResize.getAttribute("aria-valuenow"),
    "left resize handle should expose aria-valuenow",
  );
  await leftResize.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(120);
  const sidebarWidthAfterKeyboardResize =
    (await page.locator(testClass("sidebar-slot")).boundingBox())?.width ?? 0;
  assert(
    sidebarWidthAfterKeyboardResize > sidebarWidthBeforeResize,
    `left-panel-keyboard-resizes failed: ${sidebarWidthBeforeResize} -> ${sidebarWidthAfterKeyboardResize}`,
  );
  const leftResizeBoxAfterKeyboard = await leftResize.boundingBox();
  assert(
    leftResizeBoxAfterKeyboard,
    "left panel resize handle disappeared after keyboard resize",
  );
  await page.mouse.move(
    leftResizeBoxAfterKeyboard.x + leftResizeBoxAfterKeyboard.width / 2,
    leftResizeBoxAfterKeyboard.y + 96,
  );
  await page.mouse.down();
  await page.mouse.move(
    leftResizeBoxAfterKeyboard.x + leftResizeBoxAfterKeyboard.width / 2 + 56,
    leftResizeBoxAfterKeyboard.y + 96,
  );
  await page.mouse.up();
  await page.waitForTimeout(180);
  const sidebarWidthAfterResize =
    (await page.locator(testClass("sidebar-slot")).boundingBox())?.width ?? 0;
  assert(
    sidebarWidthAfterResize >= sidebarWidthBeforeResize + 44,
    `left-panel-resizes failed: ${sidebarWidthBeforeResize} -> ${sidebarWidthAfterResize}`,
  );

  const rightResize = page.locator(testClass("right-panel-resize-handle"));
  const rightPanelSlot = page.locator(testClass("right-panel-slot"));
  const inspectorWidthBeforeResize =
    (await rightPanelSlot.boundingBox())?.width ?? 0;
  const rightResizeBox = await rightResize.boundingBox();
  assert(rightResizeBox, "right panel resize handle is missing");
  assert(
    (await rightResize.getAttribute("role")) === "separator",
    "right resize handle should expose separator role",
  );
  assert(
    (await rightResize.getAttribute("aria-controls")) ===
      "butler-right-inspector",
    "right resize handle should control the inspector",
  );
  assert(
    await rightResize.getAttribute("aria-valuenow"),
    "right resize handle should expose aria-valuenow",
  );
  await page.mouse.move(
    rightResizeBox.x + rightResizeBox.width / 2,
    rightResizeBox.y + 96,
  );
  await page.mouse.down();
  await page.mouse.move(
    rightResizeBox.x + rightResizeBox.width / 2 - 56,
    rightResizeBox.y + 96,
  );
  await page.mouse.up();
  await page.waitForTimeout(180);
  const inspectorWidthAfterResize =
    (await rightPanelSlot.boundingBox())?.width ?? 0;
  assert(
    inspectorWidthAfterResize >= inspectorWidthBeforeResize + 44,
    `right-panel-resizes failed: ${inspectorWidthBeforeResize} -> ${inspectorWidthAfterResize}`,
  );
  const openRightPanelToggleState = await page
    .getByRole("button", { name: appCopy.titlebar.hideRightPanel })
    .evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
    }));
  assert(
    openRightPanelToggleState.background === "rgba(0, 0, 0, 0)",
    `right panel toggle should not show selected ghosting while open: ${JSON.stringify(openRightPanelToggleState)}`,
  );
  await page
    .getByRole("button", { name: appCopy.titlebar.hideRightPanel })
    .click();
  await page.waitForTimeout(90);
  const closingSlotBox = await rightPanelSlot.boundingBox();
  const closingInspectorBox = await page
    .locator(testClass("right-inspector"))
    .boundingBox();
  const closingInspectorState = await page
    .locator(testClass("right-inspector"))
    .evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      transform: getComputedStyle(element).transform,
      width: element.getBoundingClientRect().width,
    }));
  assert(
    closingSlotBox &&
      closingSlotBox.width > 8 &&
      closingSlotBox.width < inspectorWidthAfterResize - 8,
    `right panel slot should animate while closing: start=${inspectorWidthAfterResize} mid=${JSON.stringify(closingSlotBox)}`,
  );
  assert(
    closingInspectorBox &&
      closingInspectorBox.width >= inspectorWidthAfterResize - 2 &&
      closingInspectorState.opacity === "1" &&
      closingInspectorState.transform === "none",
    `right panel content should keep stable width while the slot clips it: box=${JSON.stringify(closingInspectorBox)} state=${JSON.stringify(closingInspectorState)}`,
  );
  await page.waitForTimeout(260);
  const closedInspectorCount = await page
    .locator(testClass("right-inspector"))
    .count();
  const closedSlotBox = await rightPanelSlot.boundingBox();
  assert(
    closedInspectorCount === 1 && (!closedSlotBox || closedSlotBox.width <= 2),
    `right panel should stay mounted in a 0px clipped slot: count=${closedInspectorCount} slotWidth=${closedSlotBox?.width}`,
  );
  const closedRightPanelToggle = page.getByRole("button", {
    name: appCopy.titlebar.showRightPanel,
  });
  await closedRightPanelToggle.hover();
  await page
    .getByRole("tooltip", { name: appCopy.titlebar.showRightPanel })
    .waitFor({ state: "visible" });
  const closedRightPanelTooltipState = await page
    .getByRole("tooltip", { name: appCopy.titlebar.showRightPanel })
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        text: element.textContent?.trim() ?? "",
        whiteSpace: getComputedStyle(element).whiteSpace,
        width: rect.width,
      };
    });
  assert(
    closedRightPanelTooltipState.whiteSpace === "nowrap" &&
      closedRightPanelTooltipState.width >
        closedRightPanelTooltipState.height * 2,
    `right panel toggle tooltip should stay horizontal when closed: ${JSON.stringify(closedRightPanelTooltipState)}`,
  );
  await page.mouse.move(720, 520);
  await page
    .getByRole("tooltip", { name: appCopy.titlebar.showRightPanel })
    .waitFor({ state: "hidden" });
  await page.evaluate((label) => {
    window.dispatchEvent(new Event("focus"));
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.getAttribute("aria-label") === label,
    );
    button?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  }, appCopy.titlebar.showRightPanel);
  await page.waitForTimeout(120);
  await expectLocatorCount(
    page,
    '[role="tooltip"]',
    0,
    "titlebar toggle tooltip should stay hidden after window focus restoration",
  );
  await page
    .getByRole("button", { name: appCopy.titlebar.showRightPanel })
    .click();
  await page.waitForTimeout(320);
  const reopenedInspectorBox = await page
    .locator(testClass("right-panel-slot"))
    .boundingBox();
  assert(
    reopenedInspectorBox &&
      reopenedInspectorBox.width >= inspectorWidthAfterResize - 2,
    `right panel should slide open again: ${reopenedInspectorBox?.width}`,
  );
  await page.setViewportSize({ width: 540, height: 760 });
  await page.waitForTimeout(320);
  const narrowInspectorBox = await page
    .locator(testClass("right-inspector"))
    .boundingBox();
  const narrowWorkspaceBox = await page
    .locator(testClass("workspace"))
    .boundingBox();
  assert(
    narrowInspectorBox &&
      narrowInspectorBox.x >= -1 &&
      narrowInspectorBox.width >= 320 &&
      narrowInspectorBox.x + narrowInspectorBox.width <= 541,
    `narrow right panel should stay visible: ${JSON.stringify(narrowInspectorBox)}`,
  );
  assert(
    narrowWorkspaceBox && narrowWorkspaceBox.width <= 2,
    `narrow right panel should sacrifice conversation width: ${JSON.stringify(narrowWorkspaceBox)}`,
  );
  const narrowOverlayState = await page
    .locator(testClass("mac-window"))
    .evaluate((root) => {
      const inspector = root.querySelector<HTMLElement>(
        "[data-test-class~='right-inspector']",
      );
      const firstTab = inspector?.querySelector<HTMLElement>("button");
      const overlay = root.querySelector<HTMLElement>(
        "[data-test-class~='right-panel-overlay-titlebar']",
      );
      const closeButton = root.querySelector<HTMLElement>(
        "[data-test-class~='right-panel-overlay-close']",
      );
      const leftToggleLayer = root.querySelector<HTMLElement>(
        "[data-test-class~='chrome-floating-toggle-layer']",
      );
      const titlebarHeight = parseFloat(
        getComputedStyle(root).getPropertyValue("--titlebar-height"),
      );
      const tabBox = firstTab?.getBoundingClientRect();
      const overlayBox = overlay?.getBoundingClientRect();
      const closeBox = closeButton?.getBoundingClientRect();
      const leftLayerBox = leftToggleLayer?.getBoundingClientRect();
      const overlayStyle = overlay ? getComputedStyle(overlay) : null;
      const closeStyle = closeButton ? getComputedStyle(closeButton) : null;
      return {
        rootClassName: root.getAttribute("class") ?? "",
        closeRight: closeBox?.right ?? Number.NaN,
        closeTop: closeBox?.top ?? Number.NaN,
        closeVisible:
          Boolean(closeBox) &&
          getComputedStyle(closeButton!).display !== "none" &&
          getComputedStyle(closeButton!).visibility !== "hidden",
        leftToggleDisplay: leftToggleLayer
          ? getComputedStyle(leftToggleLayer).display
          : "",
        leftToggleWidth: leftLayerBox?.width ?? 0,
        overlayDisplay: overlay ? getComputedStyle(overlay).display : "",
        overlayDragRegion:
          overlayStyle?.getPropertyValue("-webkit-app-region") ?? "",
        overlayHeight: overlayBox?.height ?? Number.NaN,
        closeDragRegion:
          closeStyle?.getPropertyValue("-webkit-app-region") ?? "",
        tabTop: tabBox?.top ?? Number.NaN,
        titlebarHeight,
        viewportWidth: window.innerWidth,
      };
    });
  assert(
    narrowOverlayState.tabTop >= narrowOverlayState.titlebarHeight - 1,
    `narrow right panel tabs should sit below titlebar reserve: ${JSON.stringify(narrowOverlayState)}`,
  );
  assert(
    narrowOverlayState.overlayDisplay === "flex" &&
      Math.abs(
        narrowOverlayState.overlayHeight - narrowOverlayState.titlebarHeight,
      ) <= 1,
    `narrow right panel should expose a titlebar close lane: ${JSON.stringify(narrowOverlayState)}`,
  );
  assert(
    narrowOverlayState.closeVisible &&
      narrowOverlayState.closeRight <= narrowOverlayState.viewportWidth &&
      narrowOverlayState.closeTop >= 0 &&
      narrowOverlayState.closeTop < narrowOverlayState.titlebarHeight,
    `narrow right panel close button should stay in the titlebar right edge: ${JSON.stringify(narrowOverlayState)}`,
  );
  assert(
    narrowOverlayState.overlayDragRegion === "drag" &&
      narrowOverlayState.closeDragRegion === "no-drag",
    `narrow right panel titlebar lane should remain draggable while close button stays interactive: ${JSON.stringify(narrowOverlayState)}`,
  );
  assert(
    narrowOverlayState.leftToggleDisplay === "none" ||
      narrowOverlayState.leftToggleWidth === 0,
    `narrow right panel overlay should hide the left sidebar toggle: ${JSON.stringify(narrowOverlayState)}`,
  );
  assert(
    narrowOverlayState.rootClassName.includes("left-collapsed"),
    `narrow right panel should auto-collapse the left sidebar state: ${JSON.stringify(narrowOverlayState)}`,
  );
  screenshots.push(await screenshot(page, "narrow-right-panel-visible.png"));
  await page.locator(testClass("right-panel-overlay-close")).click();
  await page.waitForTimeout(320);
  const narrowTitlebarNewChatState = await page
    .locator(testClass("mac-window"))
    .evaluate((root) => {
      const button = root.querySelector<HTMLElement>(
        "[data-test-class~='titlebar-new-chat-button']",
      );
      const title = root.querySelector<HTMLElement>(
        "[data-test-class~='titlebar-title']",
      );
      const buttonBox = button?.getBoundingClientRect();
      const titleBox = title?.getBoundingClientRect();
      return {
        buttonDisplay: button ? getComputedStyle(button).display : "",
        buttonLeft: buttonBox?.left ?? Number.NaN,
        buttonRight: buttonBox?.right ?? Number.NaN,
        buttonWidth: buttonBox?.width ?? Number.NaN,
        titleLeft: titleBox?.left ?? Number.NaN,
        titleText: title?.textContent ?? "",
      };
    });
  assert(
    narrowTitlebarNewChatState.buttonWidth >= 24 &&
      narrowTitlebarNewChatState.buttonDisplay !== "none" &&
      narrowTitlebarNewChatState.buttonRight <=
        narrowTitlebarNewChatState.titleLeft - 4,
    `narrow titlebar should show new chat before the conversation title: ${JSON.stringify(narrowTitlebarNewChatState)}`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(320);
  const showSidebarAfterNarrow = page.getByRole("button", {
    name: "Show sidebar",
  });
  if (await showSidebarAfterNarrow.isVisible()) {
    await showSidebarAfterNarrow.click();
    await page.waitForTimeout(320);
  }

  const leftResizeBoxAfterGrow = await leftResize.boundingBox();
  assert(
    leftResizeBoxAfterGrow,
    "left panel resize handle disappeared before collapse drag",
  );
  await page.mouse.move(
    leftResizeBoxAfterGrow.x + leftResizeBoxAfterGrow.width / 2,
    leftResizeBoxAfterGrow.y + 96,
  );
  await page.mouse.down();
  await page.mouse.move(180, leftResizeBoxAfterGrow.y + 96);
  await page.mouse.up();
  await page.waitForTimeout(320);
  const draggedClosedSidebarBox = await page
    .locator(testClass("sidebar-slot"))
    .boundingBox();
  assert(
    draggedClosedSidebarBox && draggedClosedSidebarBox.width <= 2,
    `left-resize-below-min-collapses failed: ${draggedClosedSidebarBox?.width}`,
  );
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.waitForTimeout(320);

  const sidebarWidthBeforeToggle =
    (await page.locator(testClass("sidebar-slot")).boundingBox())?.width ?? 0;
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.waitForTimeout(90);
  const sidebarMidToggleBox = await page
    .locator(testClass("sidebar-slot"))
    .boundingBox();
  assert(
    sidebarMidToggleBox &&
      sidebarMidToggleBox.width > 8 &&
      sidebarMidToggleBox.width < sidebarWidthBeforeToggle - 8,
    `left sidebar column should animate while closing: start=${sidebarWidthBeforeToggle} mid=${JSON.stringify(sidebarMidToggleBox)}`,
  );
  await page.waitForTimeout(320);
  const sidebarBox = await page
    .locator(testClass("sidebar-slot"))
    .boundingBox();
  assert(
    sidebarBox && sidebarBox.width <= 2,
    `sidebar should collapse to 0px, got ${sidebarBox?.width}`,
  );
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.waitForTimeout(320);
  screenshots.push(await screenshot(page, "sidebar-expanded-again.png"));

  await expectLocatorCount(
    page,
    testClass("plan-switch"),
    0,
    "plan switch should not render in the composer toolbar",
  );
  await page
    .getByRole("button", { name: appCopy.composer.attachFile })
    .waitFor({ state: "visible" });
  await assertComposerHoverPill(
    page,
    testClass("attachment-button"),
    "attachment button",
  );
  const fileInputAccept = await page
    .locator("input[type='file']")
    .getAttribute("accept");
  const fileInputPickerMode = await page
    .locator("input[type='file']")
    .getAttribute("data-picker-filter");
  assert(
    !fileInputAccept,
    `attachment-picker-all-files failed: accept=${fileInputAccept}`,
  );
  assert(
    fileInputPickerMode === "all-files",
    `attachment picker should advertise all-files mode, got ${fileInputPickerMode}`,
  );
  await page.setInputFiles("input[type='file']", {
    name: "smoke.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# smoke\n\nattachment body"),
  });
  await page.getByText("smoke.md").waitFor({ state: "visible" });
  await page.setInputFiles("input[type='file']", {
    name: "smoke.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByText("smoke.png").waitFor({ state: "visible" });
  await expectLocatorCount(
    page,
    `${testClass("composer-error")}:visible`,
    0,
    "png attachment should not show unsupported type error",
  );

  await page
    .getByRole("button", { name: appCopy.permissions.fullAccess })
    .click();
  await page.locator(testClass("composer-menu")).waitFor({ state: "visible" });
  const permissionMenuLayout = await page
    .locator(testClass("composer-menu"))
    .evaluate((menu) => {
      const content = menu.closest<HTMLElement>(
        '[data-slot="popover-content"]',
      );
      const title = menu.querySelector<HTMLElement>('[class*="title"]');
      const item = menu.querySelector<HTMLElement>(
        '[data-slot="option-menu-item"]',
      );
      const copy = item?.querySelector<HTMLElement>('[class*="copy"]');
      const icon = item?.querySelector<HTMLElement>('[class*="icon"]');
      const label = item?.querySelector<HTMLElement>('[class*="label"]');
      const description = item?.querySelector<HTMLElement>(
        '[class*="description"]',
      );
      const contentRect = content?.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      const itemRect = item?.getBoundingClientRect();
      const iconRect = icon?.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      const descriptionRect = description?.getBoundingClientRect();
      const contentStyle = content ? getComputedStyle(content) : null;
      const copyStyle = copy ? getComputedStyle(copy) : null;
      return {
        contentPaddingLeft: contentStyle
          ? parseFloat(contentStyle.paddingLeft)
          : Number.NaN,
        copyDisplay: copyStyle?.display ?? "",
        descriptionPlacement:
          item?.getAttribute("data-description-placement") ?? "",
        descriptionTop: descriptionRect?.top ?? Number.NaN,
        iconCenterY: iconRect ? iconRect.top + iconRect.height / 2 : Number.NaN,
        itemInset:
          contentRect && itemRect
            ? itemRect.left - contentRect.left
            : Number.NaN,
        itemTopGap: itemRect ? itemRect.top - menuRect.top : Number.NaN,
        labelCenterY: labelRect
          ? labelRect.top + labelRect.height / 2
          : Number.NaN,
        labelBottom: labelRect?.bottom ?? Number.NaN,
        titleHeight: titleRect?.height ?? Number.NaN,
        titleWidth: titleRect?.width ?? Number.NaN,
        width: contentRect?.width ?? Number.NaN,
      };
    });
  assert(
    permissionMenuLayout.contentPaddingLeft <= 6 &&
      permissionMenuLayout.copyDisplay === "grid" &&
      permissionMenuLayout.descriptionPlacement === "block" &&
      permissionMenuLayout.descriptionTop >= permissionMenuLayout.labelBottom &&
      Math.abs(
        permissionMenuLayout.iconCenterY - permissionMenuLayout.labelCenterY,
      ) <= 1.5 &&
      permissionMenuLayout.itemInset <= 6 &&
      permissionMenuLayout.itemTopGap <= 2 &&
      permissionMenuLayout.titleHeight <= 1 &&
      permissionMenuLayout.titleWidth <= 1 &&
      permissionMenuLayout.width <= 340,
    `permission menu should be a flat compact two-line list without visible title hierarchy or doubled padding: ${JSON.stringify(permissionMenuLayout)}`,
  );
  await page.mouse.click(80, 80);
  await page.waitForTimeout(400);
  await expectLocatorCount(
    page,
    `${testClass("composer-menu")}:visible`,
    0,
    "permission popover should close on outside click",
  );
  await page
    .getByRole("button", { name: appCopy.permissions.fullAccess })
    .click();
  await page.locator(testClass("composer-menu")).waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: appCopy.permissions.askFirst })
    .click();
  await page.locator(testClass("composer-menu")).waitFor({ state: "hidden" });
  await page.waitForTimeout(180);
  const accessButtonState = await page
    .locator(testClass("access-button"))
    .evaluate((element) => ({
      className: element.getAttribute("class"),
      dataSlot: element.getAttribute("data-slot"),
      color: getComputedStyle(element).color,
      style: element.getAttribute("style"),
      accessAsk: getComputedStyle(element).getPropertyValue("--access-ask"),
      accessFull: getComputedStyle(element).getPropertyValue("--access-full"),
      accent: getComputedStyle(element).getPropertyValue("--accent"),
      label: element.textContent ?? "",
      svgCount: element.querySelectorAll("svg").length,
    }));
  assert(
    accessButtonState.svgCount === 1 &&
      accessButtonState.label.includes(appCopy.permissions.askFirst) &&
      accessButtonState.color.includes("0, 122, 255"),
    `permission button should update icon and ask-first color: ${JSON.stringify(accessButtonState)}`,
  );
  const accessButtonGeometry = await page
    .locator(testClass("access-button"))
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const icon = element.querySelector<HTMLElement>(
        '[data-test-class~="composer-control-icon"]',
      );
      const svg = icon?.querySelector<SVGElement>("svg");
      const label = element.querySelector<HTMLElement>(
        '[data-test-class~="composer-control-label"]',
      );
      const iconBox = icon?.getBoundingClientRect();
      const svgBox = svg?.getBoundingClientRect();
      const labelBox = label?.getBoundingClientRect();
      const iconStyle = icon ? getComputedStyle(icon) : null;
      const svgStyle = svg ? getComputedStyle(svg) : null;
      return {
        alignItems: style.alignItems,
        display: style.display,
        gap: style.gap,
        iconCenterY: iconBox ? iconBox.top + iconBox.height / 2 : null,
        iconDisplay: iconStyle?.display ?? "",
        iconHeight: iconBox?.height ?? null,
        iconLineHeight: iconStyle?.lineHeight ?? "",
        labelCenterY: labelBox ? labelBox.top + labelBox.height / 2 : null,
        svgDisplay: svgStyle?.display ?? "",
        svgHeight: svgBox?.height ?? null,
      };
    });
  assert(
    ["flex", "inline-flex"].includes(accessButtonGeometry.display) &&
      accessButtonGeometry.alignItems === "center" &&
      parseFloat(accessButtonGeometry.gap) > 0,
    `composer control button should keep flex display, center alignment, and gap: ${JSON.stringify(accessButtonGeometry)}`,
  );
  assert(
    accessButtonGeometry.iconCenterY !== null &&
      accessButtonGeometry.labelCenterY !== null &&
      accessButtonGeometry.iconDisplay === "flex" &&
      accessButtonGeometry.iconLineHeight === "0px" &&
      accessButtonGeometry.svgDisplay === "block" &&
      accessButtonGeometry.iconHeight === accessButtonGeometry.svgHeight &&
      Math.abs(
        accessButtonGeometry.iconCenterY - accessButtonGeometry.labelCenterY,
      ) <= 0.5,
    `composer access icon and label should be vertically centered: ${JSON.stringify(accessButtonGeometry)}`,
  );
  await assertComposerHoverPill(
    page,
    testClass("access-button"),
    "permission button",
  );

  await page.locator(testClass("model-button")).click();
  await page
    .locator(testClass("filtered-select-popover"))
    .waitFor({ state: "visible" });
  const modelMenuLayout = await page
    .locator(testClass("filtered-select-popover"))
    .evaluate((menu) => {
      const content = menu.closest<HTMLElement>(
        '[data-slot="popover-content"]',
      );
      const item = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-item"]',
      );
      const groupTitles = Array.from(
        menu.querySelectorAll<HTMLElement>(
          '[data-slot="filtered-select-group-title"]',
        ),
      );
      const footerTitle = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-footer-title"]',
      );
      const search = menu.querySelector<HTMLElement>('[data-slot="input"]');
      const filters = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-filters"]',
      );
      const results = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-results"]',
      );
      const filterButtons = Array.from(
        menu.querySelectorAll<HTMLElement>(
          '[data-slot="filtered-select-filters"] button',
        ),
      );
      const reasoningButtons = Array.from(
        menu.querySelectorAll<HTMLElement>(
          '[data-slot="filtered-select-footer"] button',
        ),
      );
      const contentRect = content?.getBoundingClientRect();
      const itemRect = item?.getBoundingClientRect();
      const firstTitleRect = groupTitles[0]?.getBoundingClientRect();
      const resultsRect = results?.getBoundingClientRect();
      const searchRect = search?.getBoundingClientRect();
      const filtersRect = filters?.getBoundingClientRect();
      const contentStyle = content ? getComputedStyle(content) : null;
      const resolveColorToken = (token: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        menu.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return {
        contentPaddingLeft: contentStyle
          ? parseFloat(contentStyle.paddingLeft)
          : Number.NaN,
        filterColors: filterButtons.map(
          (element) => getComputedStyle(element).color,
        ),
        filterLabels: filterButtons.map(
          (element) => element.textContent?.trim() ?? "",
        ),
        footerTitle: footerTitle?.textContent?.trim() ?? "",
        groupTitles: groupTitles.map(
          (element) => element.textContent?.trim() ?? "",
        ),
        itemInset:
          contentRect && itemRect
            ? itemRect.left - contentRect.left
            : Number.NaN,
        sectionTitleInset:
          contentRect && firstTitleRect
            ? firstTitleRect.left - contentRect.left
            : Number.NaN,
        hasSearch: search != null,
        reasoningLabels: reasoningButtons.map(
          (element) => element.textContent?.trim() ?? "",
        ),
        resultsHeight: resultsRect?.height ?? Number.NaN,
        searchFilterGap:
          searchRect && filtersRect
            ? filtersRect.top - searchRect.bottom
            : Number.NaN,
        semanticTextColors: [
          resolveColorToken("--text-primary"),
          resolveColorToken("--text-secondary"),
          resolveColorToken("--text-tertiary"),
        ],
        width: contentRect?.width ?? Number.NaN,
      };
    });
  assert(
    Math.abs(
      modelMenuLayout.contentPaddingLeft -
        permissionMenuLayout.contentPaddingLeft,
    ) <= 0.5 &&
      modelMenuLayout.itemInset <= 6 &&
      modelMenuLayout.sectionTitleInset <= 6 &&
      modelMenuLayout.hasSearch &&
      modelMenuLayout.filterLabels.includes(appCopy.composer.allProviders) &&
      modelMenuLayout.groupTitles.length > 0 &&
      modelMenuLayout.footerTitle === appCopy.composer.reasoning &&
      modelMenuLayout.reasoningLabels.includes("Instant") &&
      !modelMenuLayout.reasoningLabels.some((label) =>
        label.includes("reasoning"),
      ) &&
      modelMenuLayout.resultsHeight >= 190 &&
      modelMenuLayout.resultsHeight <= 210 &&
      modelMenuLayout.searchFilterGap >= 7 &&
      modelMenuLayout.width <= 540,
    `model menu should use filtered select structure with search, provider filters, compact reasoning labels, and content-bounded width: ${JSON.stringify(modelMenuLayout)}`,
  );
  assert(
    modelMenuLayout.filterColors.every((color) =>
      modelMenuLayout.semanticTextColors.includes(color),
    ),
    `model menu filter buttons should use semantic text tokens: ${JSON.stringify(
      {
        filterColors: modelMenuLayout.filterColors,
        semanticTextColors: modelMenuLayout.semanticTextColors,
      },
    )}`,
  );
  const modelSearchInput = page.locator(testClass("filtered-select-search"));
  const modelResults = page.locator('[data-slot="filtered-select-results"]');
  await modelSearchInput.fill("gpt-5.4");
  const filteredResultsHeight = await modelResults.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  assert(
    Math.abs(filteredResultsHeight - modelMenuLayout.resultsHeight) <= 2,
    `filtered model results should keep stable height after search: ${JSON.stringify({ before: modelMenuLayout.resultsHeight, after: filteredResultsHeight })}`,
  );
  await modelSearchInput.fill("no-such-model");
  await page.getByText(appCopy.composer.noModels).waitFor({ state: "visible" });
  const emptyResultsHeight = await modelResults.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  assert(
    Math.abs(emptyResultsHeight - modelMenuLayout.resultsHeight) <= 2,
    `filtered model results should keep stable height with no matches: ${JSON.stringify({ before: modelMenuLayout.resultsHeight, after: emptyResultsHeight })}`,
  );
  await page
    .locator(testClass("filtered-select-clear"))
    .waitFor({ state: "visible" });
  await page.locator(testClass("filtered-select-clear")).click();
  assert(
    (await modelSearchInput.inputValue()) === "",
    "filtered select clear button should reset the search input",
  );
  await page
    .locator(testClass("filtered-select-popover"))
    .waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await expectLocatorCount(
    page,
    `${testClass("filtered-select-popover")}:visible`,
    0,
    "model popover should close on Escape",
  );
  await page.locator(testClass("model-button")).click();
  await page
    .locator(testClass("filtered-select-popover"))
    .waitFor({ state: "visible" });
  await page.getByRole("button", { name: /GPT-5.4 Mini/i }).click();
  await expectLocatorCount(
    page,
    `${testClass("filtered-select-popover")}:visible`,
    1,
    "model menu should stay open after model selection so reasoning can be chosen next",
  );
  await page
    .locator(testClass("filtered-select-popover"))
    .getByRole("button", { name: "High", exact: true })
    .click();
  await expectLocatorCount(
    page,
    `${testClass("filtered-select-popover")}:visible`,
    0,
    "model menu should close after reasoning selection",
  );
  const modelButtonText = await page
    .locator(testClass("model-button"))
    .textContent();
  assert(
    (modelButtonText ?? "").includes("High") &&
      !(modelButtonText ?? "").includes("reasoning") &&
      !(modelButtonText ?? "").includes("No reasoning"),
    `model trigger should render model and compact reasoning without reasoning suffix: ${modelButtonText}`,
  );
  const modelButtonIconCount = await page
    .getByRole("button", { name: /GPT-5.4 Mini/i })
    .evaluate((element) => element.querySelectorAll("svg").length);
  assert(
    modelButtonIconCount === 0,
    `model selector trigger should not show a trailing chevron, got ${modelButtonIconCount} icons`,
  );
  const modelButtonGeometry = await page
    .locator(testClass("model-button"))
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const modelName = element.querySelector<HTMLElement>(
        '[data-test-class~="composer-model-name"]',
      );
      const modelSummary = element.querySelector<HTMLElement>(
        '[data-test-class~="composer-model-summary"]',
      );
      const nameBox = modelName?.getBoundingClientRect();
      const summaryBox = modelSummary?.getBoundingClientRect();
      return {
        alignItems: style.alignItems,
        display: style.display,
        gap: style.gap,
        nameCenterY: nameBox ? nameBox.top + nameBox.height / 2 : null,
        summaryCenterY: summaryBox
          ? summaryBox.top + summaryBox.height / 2
          : null,
      };
    });
  assert(
    ["flex", "inline-flex"].includes(modelButtonGeometry.display) &&
      modelButtonGeometry.alignItems === "center" &&
      parseFloat(modelButtonGeometry.gap) > 0,
    `composer model button should keep flex display, center alignment, and gap: ${JSON.stringify(modelButtonGeometry)}`,
  );
  assert(
    modelButtonGeometry.nameCenterY !== null &&
      modelButtonGeometry.summaryCenterY !== null &&
      Math.abs(
        modelButtonGeometry.nameCenterY - modelButtonGeometry.summaryCenterY,
      ) <= 1.5,
    `composer model labels should be vertically centered: ${JSON.stringify(modelButtonGeometry)}`,
  );
  await assertComposerHoverPill(
    page,
    testClass("model-button"),
    "model button",
  );
  const contextButton = page.locator(testClass("context-donut-button")).first();
  if (!(await contextButton.isDisabled())) {
    await assertComposerHoverPill(
      page,
      testClass("context-donut-button"),
      "context button",
    );
  }
  screenshots.push(await screenshot(page, "composer-controls.png"));

  const showRightPanelForArtifacts = page.getByRole("button", {
    name: appCopy.titlebar.showRightPanel,
  });
  if (await showRightPanelForArtifacts.isVisible()) {
    await showRightPanelForArtifacts.click();
    await page.waitForTimeout(320);
  }
  await page
    .getByRole("button", { name: appCopy.inspector.tabs.artifacts })
    .click();
  const artifactTile = page
    .locator("[data-slot='document-tile'][role='button']")
    .first();
  if ((await artifactTile.count()) > 0) {
    await artifactTile.click();
    await page
      .locator(testClass("artifact-viewer"))
      .waitFor({ state: "visible" });
  } else {
    await page.getByText(appCopy.artifacts.empty).waitFor({ state: "visible" });
  }
  screenshots.push(await screenshot(page, "artifact-detail.png"));

  await page.getByRole("button", { name: appCopy.sidebar.settings }).click();
  await page.locator(testClass("settings-view")).waitFor({ state: "visible" });
  await page
    .locator(testClass("settings-titlebar"))
    .waitFor({ state: "visible" });
  await expectLocatorCount(
    page,
    `${testClass("settings-status")}:visible`,
    0,
    "settings should not show stale saved status on first open",
  );
  await expectLocatorCount(
    page,
    `${testClass("app-sidebar")}:visible`,
    0,
    "settings should replace the app sidebar",
  );
  const settingsBox = await page
    .locator(testClass("settings-view"))
    .boundingBox();
  assert(
    settingsBox && settingsBox.x <= 1 && settingsBox.width >= 1438,
    "settings should cover the full app width",
  );
  const settingsTitlebarDrag = await page
    .locator(testClass("settings-titlebar"))
    .evaluate((node) =>
      getComputedStyle(node).getPropertyValue("-webkit-app-region"),
    );
  assert(
    settingsTitlebarDrag === "drag",
    `settings titlebar should remain draggable, got ${settingsTitlebarDrag}`,
  );
  const settingsDetailDrag = await page
    .locator(".settings-detail")
    .evaluate((node) =>
      getComputedStyle(node).getPropertyValue("-webkit-app-region"),
    );
  assert(
    settingsDetailDrag === "drag",
    `settings detail top area should remain draggable, got ${settingsDetailDrag}`,
  );
  await page
    .getByRole("button", { name: appCopy.settings.sections.models })
    .click();
  await page
    .getByRole("heading", { name: appCopy.settings.panels.butlerModel })
    .waitFor({ state: "visible" });
  const settingsScrollState = await page
    .locator(testClass("settings-detail-scroll"))
    .evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return {
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    });
  assert(
    settingsScrollState.scrollTop > 0,
    `settings detail should be scrollable for drag regression check: ${JSON.stringify(settingsScrollState)}`,
  );
  const settingsDragLaneAfterScroll = await page
    .locator(testClass("settings-detail-drag-lane"))
    .evaluate((lane) => {
      const rect = lane.getBoundingClientRect();
      const style = getComputedStyle(lane);
      const sampleY = rect.top + Math.min(24, rect.height / 2);
      const sidebarHit = document.elementFromPoint(
        rect.left + Math.min(120, rect.width / 3),
        sampleY,
      ) as HTMLElement | null;
      const detailHit = document.elementFromPoint(
        rect.right - Math.min(120, rect.width / 3),
        sampleY,
      ) as HTMLElement | null;
      return {
        detailHitTestClass: detailHit?.getAttribute("data-test-class") ?? "",
        region: style.getPropertyValue("-webkit-app-region"),
        height: rect.height,
        sidebarHitTestClass:
          sidebarHit?.getAttribute("data-test-class") ?? "",
        top: rect.top,
      };
    });
  assert(
    settingsDragLaneAfterScroll.region === "drag" &&
      settingsDragLaneAfterScroll.sidebarHitTestClass.includes(
        "settings-detail-drag-lane",
      ) &&
      settingsDragLaneAfterScroll.detailHitTestClass.includes(
        "settings-detail-drag-lane",
      ),
    `settings titlebar overlay should remain the top hit target after detail scroll: ${JSON.stringify(settingsDragLaneAfterScroll)}`,
  );
  await expectLocatorCount(
    page,
    rightPanelToggleSelector,
    0,
    "right panel toggle should be hidden on settings",
  );
  const settingsTitleColor = await page
    .locator(testClass("settings-detail-title"))
    .evaluate((element) => getComputedStyle(element).color);
  assert(
    settingsTitleColor.includes("34, 35, 38"),
    `light settings title should inherit light text token: ${settingsTitleColor}`,
  );
  screenshots.push(await screenshot(page, "settings-no-right-toggle.png"));
  await page
    .getByRole("button", { name: appCopy.settings.sections.appearance })
    .click();
  await page
    .locator(testClass("settings-main-screen-theme-select"))
    .waitFor({ state: "visible" });
  await page.locator(testClass("settings-main-screen-theme-select")).click();
  await page
    .getByRole("option", {
      exact: true,
      name: appCopy.settings.options.mainScreenThemeNone,
    })
    .waitFor({ state: "visible" });
  await page
    .getByRole("option", {
      exact: true,
      name: appCopy.settings.options.mainScreenThemeBloom,
    })
    .waitFor({ state: "visible" });
  await page
    .getByRole("option", {
      exact: true,
      name: appCopy.settings.options.mainScreenThemeSilk,
    })
    .waitFor({ state: "visible" });
  await page
    .getByRole("option", {
      exact: true,
      name: appCopy.settings.options.mainScreenThemeSilk,
    })
    .click();
  await page
    .locator(testClass("settings-main-screen-theme-preset-select"))
    .waitFor({ state: "detached" });
  await expectLocatorCount(
    page,
    testClass("settings-main-screen-theme-preset-select"),
    0,
    "silk main screen theme should not show palette detail controls",
  );
  await expectLocatorCount(
    page,
    testClass("settings-main-screen-theme-color"),
    0,
    "silk main screen theme should not show custom color controls",
  );
  await page.locator(testClass("settings-main-screen-theme-select")).click();
  await page
    .getByRole("option", {
      exact: true,
      name: appCopy.settings.options.mainScreenThemeBloom,
    })
    .click();
  await page
    .locator(testClass("settings-main-screen-theme-preset-select"))
    .waitFor({ state: "visible" });
  await page
    .locator(testClass("settings-main-screen-theme-preset-select"))
    .click();
  await page
    .getByRole("option", {
      exact: true,
      name: appCopy.settings.options.paletteCustom,
    })
    .click();
  await page
    .locator(testClass("settings-main-screen-theme-color"))
    .first()
    .waitFor({ state: "visible" });
  const bloomColorState = await page
    .locator(testClass("settings-main-screen-theme-color"))
    .first()
    .evaluate((element) => {
      const inputBox = element.getBoundingClientRect();
      const inputStyle = getComputedStyle(element);
      const chip = element.parentElement as HTMLElement | null;
      const chipBox = chip?.getBoundingClientRect();
      const chipStyle = chip ? getComputedStyle(chip) : null;
      return {
        chipHeight: chipBox?.height ?? 0,
        chipRadius: chipStyle?.borderRadius ?? "",
        chipWidth: chipBox?.width ?? 0,
        inputBorder: inputStyle.borderTopWidth,
        inputHeight: inputBox.height,
        inputWidth: inputBox.width,
      };
    });
  assert(
    Math.abs(bloomColorState.chipWidth - bloomColorState.chipHeight) <= 1 &&
      Number.parseFloat(bloomColorState.chipRadius) >=
        bloomColorState.chipWidth / 2 - 1 &&
      Math.abs(bloomColorState.inputWidth - bloomColorState.inputHeight) <= 1 &&
      bloomColorState.inputBorder === "0px",
    `settings bloom color controls should render as circular swatches: ${JSON.stringify(bloomColorState)}`,
  );
  await page
    .getByRole("button", { name: appCopy.settings.sections.models })
    .click();
  await page
    .getByRole("heading", { name: appCopy.settings.panels.butlerModel })
    .waitFor({ state: "visible" });
  await page
    .getByText(appCopy.settings.panels.workerModelRules)
    .waitFor({ state: "visible" });
  await page.getByText("Deep work").waitFor({ state: "visible" });
  await page.getByText("Routine work").waitFor({ state: "visible" });
  await page.getByText("GPT-5.4 Mini").waitFor({ state: "visible" });
  const localModelsTitle = page.getByText(appCopy.settings.localModels.title);
  if ((await localModelsTitle.count()) > 0) {
    await localModelsTitle.waitFor({ state: "visible" });
  } else {
    await page
      .locator(testClass("settings-model-management-button"))
      .waitFor({ state: "visible" });
  }
  const contextLimitInput = page
    .locator(testClass("settings-field"), {
      hasText: appCopy.settings.fields.contextLimit,
    })
    .locator('input:not([type="range"])');
  const contextLimitSlider = page
    .locator(testClass("settings-field"), {
      hasText: appCopy.settings.fields.contextLimit,
    })
    .locator('input[type="range"]');
  await contextLimitSlider.waitFor({ state: "visible" });
  const contextLimitChips = await page
    .locator(testClass("settings-field"), {
      hasText: appCopy.settings.fields.contextLimit,
    })
    .locator('[data-slot="token"]')
    .count();
  assert(
    contextLimitChips === 0,
    `context limit should use numeric input plus slider, not token chips: ${contextLimitChips}`,
  );
  await contextLimitInput.fill("120000");
  assert(
    await contextLimitInput.getAttribute("aria-describedby"),
    "context limit input should describe its helper text",
  );
  await contextLimitInput.press("Enter");
  await page.waitForTimeout(500);
  await expectLocatorCount(
    page,
    `${testClasses("settings-status", "error")}:visible`,
    0,
    "context limit update should not show settings error",
  );
  assert(
    (await contextLimitInput.inputValue()) === "120000",
    "context limit setting should accept a lower effective token budget",
  );
  const workerRulePanel = page.locator(testClass("worker-model-rule")).first();
  const workerRuleBorder = await workerRulePanel.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderTopColor,
      borderWidth: style.borderTopWidth,
    };
  });
  assert(
    parseFloat(workerRuleBorder.borderWidth) >= 1,
    `worker model rules should be bordered repeated items: ${JSON.stringify(workerRuleBorder)}`,
  );
  const workerEnableField = page
    .locator(testClasses("settings-field", "worker-rule-enabled-field"))
    .first();
  const enableLabelBox = await workerEnableField.locator("label").boundingBox();
  const enableSwitchBox = await workerEnableField
    .locator('[role="switch"]')
    .boundingBox();
  assert(
    enableLabelBox &&
      enableSwitchBox &&
      enableSwitchBox.y > enableLabelBox.y + enableLabelBox.height - 1,
    "worker rule enable switch should be a vertical SettingsField, not a header action row",
  );
  const localBudgetSlider = page
    .locator(testClasses("settings-field", "local-reasoning-budget-field"))
    .locator('[data-slot="slider"]');
  if ((await localBudgetSlider.count()) > 0) {
    await localBudgetSlider.waitFor({ state: "visible" });
  }
  const rangeInputs = await page.locator('input[type="range"]').count();
  const dsSliders = await page.locator('[data-slot="slider"]').count();
  assert(
    rangeInputs === dsSliders,
    `settings range controls must be DS Slider instances: ranges=${rangeInputs}, sliders=${dsSliders}`,
  );
  const registeredLocalModel = page
    .locator(testClass("registered-local-model-row"))
    .first();
  if ((await registeredLocalModel.count()) > 0) {
    await registeredLocalModel.waitFor({ state: "visible" });
    const registeredLocalModelBorder = await registeredLocalModel.evaluate(
      (element) => {
        const style = getComputedStyle(element);
        return style.borderTopWidth;
      },
    );
    assert(
      parseFloat(registeredLocalModelBorder) >= 1,
      `registered local models should have item boundaries: ${registeredLocalModelBorder}`,
    );
    await registeredLocalModel.scrollIntoViewIfNeeded();
  } else {
    await page
      .locator(testClass("settings-model-management-button"))
      .scrollIntoViewIfNeeded();
  }
  screenshots.push(await screenshot(page, "settings-local-models-detail.png"));
  await page
    .getByRole("heading", { name: appCopy.settings.panels.butlerModel })
    .scrollIntoViewIfNeeded();
  const settingsModelsText = await page
    .locator(testClass("settings-view"))
    .innerText();
  const unsupportedProviderMarkers = [
    ["A", "n", "t", "h", "r", "o", "p", "i", "c"].join(""),
    ["C", "l", "a", "u", "d", "e"].join(""),
    ["G", "e", "m", "i", "n", "i"].join(""),
    ["G", "o", "o", "g", "l", "e"].join(""),
  ];
  assert(
    unsupportedProviderMarkers.every(
      (marker) => !settingsModelsText.includes(marker),
    ),
    `unsupported provider preset leaked into settings: ${settingsModelsText}`,
  );
  screenshots.push(await screenshot(page, "settings-models.png"));
  await page.getByRole("button", { name: appCopy.settings.back }).click();
  await page.locator(testClass("conversation")).waitFor({ state: "visible" });
  await page.getByRole("button", { name: appCopy.sidebar.settings }).click();
  await page.locator(testClass("settings-view")).waitFor({ state: "visible" });
  await expectLocatorCount(
    page,
    `${testClass("settings-status")}:visible`,
    0,
    "settings should clear saved status after closing and reopening",
  );
  await page.keyboard.press("Escape");
  await page.locator(testClass("conversation")).waitFor({ state: "visible" });

  await page.getByRole("button", { name: appCopy.sidebar.settings }).click();
  await page.locator(testClass("settings-view")).waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: appCopy.settings.sections.models })
    .click();
  await page.locator(testClass("settings-primary-reasoning-select")).click();
  await page
    .locator('[data-slot="select-content"]')
    .waitFor({ state: "visible" });
  const settingsSelectGlass = await page
    .locator('[data-slot="select-content"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
      };
    });
  assert(
    settingsSelectGlass.background === composerGlass.background &&
      settingsSelectGlass.borderColor === composerGlass.borderColor &&
      settingsSelectGlass.backdrop.includes("blur"),
    `select-liquid-glass-tokenized failed: ${JSON.stringify(settingsSelectGlass)}`,
  );

  await page.goto(`${server.url}?visual=components&theme=dark`, {
    waitUntil: "networkidle",
  });
  await page.locator(testClass("conversation")).waitFor({ state: "visible" });
  await page.waitForTimeout(260);
  const darkSurfaces = await page.evaluate(
    (selectors) => {
      const elementFor = (key: keyof typeof selectors) =>
        document.querySelector(selectors[key]);
      const missing = Object.keys(selectors).filter(
        (key) => !elementFor(key as keyof typeof selectors),
      );
      if (missing.length > 0) {
        return {
          missing,
          workspace: "",
          conversation: "",
          workerPanel: "",
          userBubble: "",
          rootColor: "",
          titleColor: "",
          titleControlColor: "",
          userColor: "",
          composerBorder: "",
        };
      }
      const styleFor = (key: keyof typeof selectors) =>
        getComputedStyle(elementFor(key)!);
      const conversationStyle = styleFor("conversation");
      const userBubbleStyle = styleFor("userBubble");
      return {
        missing,
        workspace: styleFor("workspace").backgroundColor,
        conversation:
          conversationStyle.backgroundImage ||
          conversationStyle.backgroundColor,
        workerPanel: styleFor("workerPanel").backgroundColor,
        userBubble: userBubbleStyle.backgroundColor,
        rootColor: styleFor("root").color,
        titleColor: styleFor("titlebarTitle").color,
        titleControlColor: styleFor("titlebarControl").color,
        userColor: userBubbleStyle.color,
        composerBorder: styleFor("composer").borderTopColor,
      };
    },
    {
      composer: testClass("composer-card"),
      conversation: testClass("conversation"),
      root: testClass("mac-window"),
      titlebarControl: `${testClass("project-controls")} button`,
      titlebarTitle: testClass("titlebar-title"),
      userBubble: `${testClasses("message", "user")} ${testClass("message-body")}`,
      workerPanel: testClass("worker-composer-panel"),
      workspace: testClass("workspace"),
    },
  );
  assert(
    darkSurfaces.missing.length === 0,
    `dark theme surface selectors are missing: ${darkSurfaces.missing.join(", ")}`,
  );
  assert(
    !darkSurfaces.workspace.includes("255, 255, 255"),
    `dark workspace should not be white: ${darkSurfaces.workspace}`,
  );
  assert(
    !darkSurfaces.conversation.includes("255, 255, 255"),
    `dark conversation should not be white: ${darkSurfaces.conversation}`,
  );
  assert(
    !darkSurfaces.workerPanel.includes("241, 242, 244"),
    `dark worker panel should not use light token: ${darkSurfaces.workerPanel}`,
  );
  assert(
    !darkSurfaces.userBubble.includes("244, 245, 247"),
    `dark user bubble should not use light token: ${darkSurfaces.userBubble}`,
  );
  assert(
    !darkSurfaces.rootColor.includes("34, 35, 38"),
    `dark root text should not inherit light color: ${darkSurfaces.rootColor}`,
  );
  assert(
    !darkSurfaces.titleColor.includes("34, 35, 38") &&
      !darkSurfaces.titleControlColor.includes("34, 35, 38"),
    `dark titlebar should inherit dark text tokens: ${JSON.stringify(darkSurfaces)}`,
  );
  assert(
    !darkSurfaces.userColor.includes("34, 35, 38"),
    `dark user text should not inherit light color: ${darkSurfaces.userColor}`,
  );
  assert(
    darkSurfaces.composerBorder === "rgba(0, 0, 0, 0.08)",
    `dark composer glass should use black translucent hairline: ${darkSurfaces.composerBorder}`,
  );
  await page
    .getByRole("button", { name: appCopy.composer.contextDetails })
    .hover();
  await page.getByText(/Context window:/u).waitFor({ state: "visible" });
  const darkContextPopoverBg = await page
    .locator(testClass("context-popover"))
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert(
    !darkContextPopoverBg.includes("255, 255, 255"),
    `context popover should inherit dark theme tokens: ${darkContextPopoverBg}`,
  );
  await page.mouse.move(40, 40);
  const showSidebarForDarkTooltip = page.getByRole("button", {
    name: "Show sidebar",
  });
  if (await showSidebarForDarkTooltip.isVisible()) {
    await showSidebarForDarkTooltip.click();
    await page.waitForTimeout(320);
  }
  await page.getByRole("button", { name: "Hide sidebar" }).hover();
  await page
    .getByRole("tooltip", { name: "Hide sidebar" })
    .waitFor({ state: "visible" });
  const darkTooltipSurface = await page
    .getByRole("tooltip", { name: "Hide sidebar" })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
      };
    });
  assert(
    !darkTooltipSurface.background.includes("255, 255, 255") &&
      darkTooltipSurface.borderColor === "rgba(0, 0, 0, 0.08)" &&
      darkTooltipSurface.backdrop.includes("blur"),
    `tooltip-theme-tokenized failed: ${JSON.stringify(darkTooltipSurface)}`,
  );
  await page.mouse.move(40, 40);
  await page.locator(testClass("model-button")).click();
  await page
    .locator(testClass("filtered-select-popover"))
    .waitFor({ state: "visible" });
  const darkModelMenuColors = await page
    .locator(testClass("filtered-select-popover"))
    .evaluate((menu) => {
      const selectedFilter = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-filters"] button[data-selected="true"]',
      );
      const firstItem = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-item"]',
      );
      const title = menu.querySelector<HTMLElement>(
        '[data-slot="filtered-select-group-title"]',
      );
      return {
        item: firstItem ? getComputedStyle(firstItem).color : "",
        selectedFilter: selectedFilter
          ? getComputedStyle(selectedFilter).color
          : "",
        title: title ? getComputedStyle(title).color : "",
      };
    });
  assert(
    Object.values(darkModelMenuColors).every(
      (color) =>
        color && !color.includes("31, 32, 35") && !color.includes("34, 35, 38"),
    ),
    `dark model menu should not render light-theme black text: ${JSON.stringify(darkModelMenuColors)}`,
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: appCopy.permissions.askFirst })
    .click();
  await page.locator(testClass("composer-menu")).waitFor({ state: "visible" });
  await page
    .locator(testClass("composer-menu"))
    .getByRole("button", { name: appCopy.permissions.readOnly })
    .click();
  await page.locator(testClass("composer-menu")).waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: appCopy.permissions.readOnly })
    .click();
  await page.locator(testClass("composer-menu")).waitFor({ state: "visible" });
  const darkPermissionMenuColors = await page
    .locator(testClass("composer-menu"))
    .evaluate((menu, readOnlyLabel) => {
      const readOnlyItem = Array.from(
        menu.querySelectorAll<HTMLElement>('[data-slot="option-menu-item"]'),
      ).find((item) => item.textContent?.includes(readOnlyLabel));
      const label = readOnlyItem?.querySelector<HTMLElement>(
        '[data-slot="option-menu-item-label"]',
      );
      const description = readOnlyItem?.querySelector<HTMLElement>(
        '[data-slot="option-menu-item-description"]',
      );
      const icon = readOnlyItem?.querySelector<HTMLElement>(
        '[data-slot="option-menu-item-icon"]',
      );
      return {
        description: description ? getComputedStyle(description).color : "",
        icon: icon ? getComputedStyle(icon).color : "",
        label: label ? getComputedStyle(label).color : "",
      };
    }, appCopy.permissions.readOnly);
  assert(
    Object.values(darkPermissionMenuColors).every(
      (color) =>
        color && !color.includes("31, 32, 35") && !color.includes("34, 35, 38"),
    ),
    `dark permission menu should not render light-theme black text: ${JSON.stringify(darkPermissionMenuColors)}`,
  );
  await page.keyboard.press("Escape");
  await page.mouse.move(40, 40);
  screenshots.push(await screenshot(page, "dark-theme-components.png"));

  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    root?.classList.remove("theme-system", "theme-dark");
    root?.classList.add("theme-light");
  }, testClass("mac-window"));
  await page.waitForTimeout(260);
  const lightSidebar = await page
    .locator(testClass("sidebar-slot"))
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const lightTitleColor = await page
    .locator(testClass("titlebar-title"))
    .evaluate((element) => getComputedStyle(element).color);
  assert(
    !lightSidebar.includes("36, 37, 40") &&
      !lightSidebar.includes("20, 21, 23"),
    `light-theme-sidebar-tokenized failed: ${lightSidebar}`,
  );
  assert(
    lightTitleColor.includes("34, 35, 38"),
    `light titlebar should inherit light text token after theme switch: ${lightTitleColor}`,
  );

  await page.goto(server.url, { waitUntil: "networkidle" });
  await page
    .locator(testClass("custom-titlebar"))
    .getByText("New chat", { exact: true })
    .waitFor({ state: "visible" });
  await page
    .locator(testClass("new-chat-empty-state"))
    .waitFor({ state: "visible" });
  const emptyStateLayout = await page
    .locator(testClass("new-chat-empty-state"))
    .evaluate(async (element) => {
      const cards = Array.from(
        element.querySelectorAll<HTMLElement>(
          '[data-test-class~="new-chat-suggestion"]',
        ),
      );
      const title = element.querySelector<HTMLElement>("h2");
      const titleIcon = element.querySelector<HTMLElement>(
        '[data-slot="prompt-suggestion-title-icon"]',
      );
      const titleIconImage = titleIcon?.querySelector<HTMLImageElement>("img");
      const titleCopy = element.querySelector<HTMLElement>(
        '[data-slot="prompt-suggestion-title-copy"]',
      );
      const moment = element.querySelector<HTMLElement>(
        '[data-slot="prompt-suggestion-moment"]',
      );
      const composer = document.querySelector<HTMLElement>(
        '[data-test-class~="composer-card"]',
      );
      const fluid = element.querySelector<HTMLElement>(
        '[data-test-class~="new-chat-fluid-gradient"]',
      );
      const railViewport = element.querySelector<HTMLElement>(
        '[data-test-class~="new-chat-suggestion-rail"]',
      );
      const railGrid = element.querySelector<HTMLElement>(
        '[data-test-class~="new-chat-suggestions"]',
      );
      const scroll = element.closest<HTMLElement>(
        '[data-test-class~="conversation-scroll"]',
      );
      const titlebar = document.querySelector<HTMLElement>(
        '[data-test-class~="custom-titlebar"]',
      );
      const workspace = document.querySelector<HTMLElement>(
        '[data-test-class~="workspace"]',
      );
      const firstTitle = cards[0]?.querySelector<HTMLElement>(
        '[data-slot="prompt-suggestion-title"]',
      );
      const firstDescription = cards[0]?.querySelector<HTMLElement>(
        '[data-slot="prompt-suggestion-description"]',
      );
      const firstMeta = cards[0]?.querySelector<HTMLElement>(
        '[data-slot="prompt-suggestion-meta"]',
      );
      const cardRect = cards[0]?.getBoundingClientRect();
      const emptyRect = element.getBoundingClientRect();
      const fluidRect = fluid?.getBoundingClientRect();
      const momentRect = moment?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      const titleCopyRect = titleCopy?.getBoundingClientRect();
      const titleIconRect = titleIcon?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const titlebarRect = titlebar?.getBoundingClientRect();
      const railViewportRect = railViewport?.getBoundingClientRect();
      const railGridRect = railGrid?.getBoundingClientRect();
      const firstTitleRect = firstTitle?.getBoundingClientRect();
      const firstDescriptionRect = firstDescription?.getBoundingClientRect();
      const firstMetaRect = firstMeta?.getBoundingClientRect();
      const scrollStyle = scroll ? getComputedStyle(scroll) : null;
      const fluidStyle = fluid ? getComputedStyle(fluid) : null;
      const titlebarStyle = titlebar ? getComputedStyle(titlebar) : null;
      const workspaceStyle = workspace ? getComputedStyle(workspace) : null;
      const measureFluidFrame = () => {
        if (!(fluid instanceof HTMLCanvasElement)) {
          return {
            activeCells: 0,
            averageTone: 0,
            grayCoverage: 1,
            minTone: 0,
            visibleCoverage: 0,
          };
        }
        const webgl = fluid.getContext("webgl");
        const canvas2d = webgl ? null : fluid.getContext("2d");
        const width = webgl?.drawingBufferWidth ?? fluid.width;
        const height = webgl?.drawingBufferHeight ?? fluid.height;
        let pixels: Uint8Array | Uint8ClampedArray | undefined;
        if (webgl) {
          const buffer = new Uint8Array(width * height * 4);
          webgl.readPixels(
            0,
            0,
            width,
            height,
            webgl.RGBA,
            webgl.UNSIGNED_BYTE,
            buffer,
          );
          pixels = buffer;
        } else {
          pixels = canvas2d?.getImageData(0, 0, width, height).data;
        }
        if (!pixels?.length || !width || !height) {
          return {
            activeCells: 0,
            averageTone: 0,
            grayCoverage: 1,
            minTone: 0,
            visibleCoverage: 0,
          };
        }
        let grayPixels = 0;
        let visiblePixels = 0;
        let toneTotal = 0;
        let minTone = 255;
        const cellVisible = new Array<number>(12).fill(0);
        const cellTotal = new Array<number>(12).fill(0);
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index] ?? 255;
          const green = pixels[index + 1] ?? 255;
          const blue = pixels[index + 2] ?? 255;
          const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          const saturation =
            Math.max(red, green, blue) - Math.min(red, green, blue);
          const pixel = index / 4;
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          const cell =
            Math.min(3, Math.floor((x / width) * 4)) +
            Math.min(2, Math.floor((y / height) * 3)) * 4;
          if (luminance <= 230) grayPixels += 1;
          if (saturation >= 18) {
            visiblePixels += 1;
            cellVisible[cell] += 1;
          }
          cellTotal[cell] += 1;
          toneTotal += luminance;
          minTone = Math.min(minTone, luminance);
        }
        const total = pixels.length / 4;
        return {
          activeCells: cellVisible.filter((count, cell) => {
            const totalForCell = cellTotal[cell] || 1;
            return count / totalForCell >= 0.015;
          }).length,
          averageTone: toneTotal / total,
          grayCoverage: grayPixels / total,
          minTone,
          visibleCoverage: visiblePixels / total,
        };
      };
      const fluidSamples: Array<{
        activeCells: number;
        averageTone: number;
        grayCoverage: number;
        minTone: number;
        visibleCoverage: number;
      }> = [];
      for (let index = 0; index < 5; index += 1) {
        fluidSamples.push(measureFluidFrame());
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return {
        cardCount: cards.length,
        cardHasTintedGlass:
          cards[0]?.getAttribute("data-slot") === "tinted-glass",
        cardIconCount: cards.reduce(
          (count, card) => count + card.querySelectorAll("svg").length,
          0,
        ),
        cardWidth: cardRect?.width ?? 0,
        cardHeight: cardRect?.height ?? 0,
        emptyWidth: emptyRect.width,
        fluidCovers: fluidRect
          ? Math.abs(fluidRect.top) <= 1 &&
            fluidRect.bottom >= window.innerHeight - 1 &&
            fluidRect.left <= emptyRect.left + 1 &&
            fluidRect.right >= emptyRect.right - 1
          : false,
        fluidAverageToneMin: Math.min(
          ...fluidSamples.map((sample) => sample.averageTone),
        ),
        fluidGrayCoverageMax: Math.max(
          ...fluidSamples.map((sample) => sample.grayCoverage),
        ),
        fluidMinToneMin: Math.min(
          ...fluidSamples.map((sample) => sample.minTone),
        ),
        fluidVisibleCoverageMin: Math.min(
          ...fluidSamples.map((sample) => sample.visibleCoverage),
        ),
        fluidActiveCellsMin: Math.min(
          ...fluidSamples.map((sample) => sample.activeCells),
        ),
        fluidTopLeftRadius: Number.parseFloat(
          fluidStyle?.borderTopLeftRadius ?? "0",
        ),
        fluidBottomLeftRadius: Number.parseFloat(
          fluidStyle?.borderBottomLeftRadius ?? "0",
        ),
        railGridWidth: railGridRect?.width ?? 0,
        railScrollWidth: railViewport?.scrollWidth ?? 0,
        railViewportWidth: railViewportRect?.width ?? 0,
        scrollClientHeight: scroll?.clientHeight ?? 0,
        scrollHeight: scroll?.scrollHeight ?? 0,
        scrollOverflowY: scrollStyle?.overflowY ?? "",
        railViewportAligned: railViewportRect
          ? Math.abs(railViewportRect.left - emptyRect.left) <= 1 &&
            Math.abs(railViewportRect.right - emptyRect.right) <= 1
          : false,
        cardDescriptionBelowTitle:
          firstTitleRect && firstDescriptionRect
            ? firstDescriptionRect.top > firstTitleRect.bottom
            : false,
        cardMetaBeforeTitle:
          firstMetaRect && firstTitleRect
            ? firstMetaRect.bottom < firstTitleRect.top
            : false,
        cardGraphicCount: cards.reduce(
          (count, card) =>
            count +
            card.querySelectorAll('[data-slot="prompt-suggestion-graphic"]')
              .length,
          0,
        ),
        momentAboveTitle:
          momentRect && titleRect ? momentRect.bottom < titleRect.top : false,
        momentShowsTime: /\d{1,2}:\d{2}/u.test(
          moment?.textContent?.trim() ?? "",
        ),
        titleFontSize: title
          ? Number.parseFloat(getComputedStyle(title).fontSize)
          : 0,
        titleStartsHigh:
          titleRect && titlebarRect
            ? titleRect.top <= titlebarRect.bottom + 86
            : false,
        titleIconAligned:
          titleIconRect && titleRect
            ? Math.abs(titleIconRect.top - titleRect.top) <= 1
            : false,
        titleIconUsesAssetImage:
          titleIconImage?.complete === true &&
          titleIconImage.naturalWidth > 0 &&
          titleIconImage.src.includes("butler-mark") &&
          (titleIcon?.querySelectorAll("svg").length ?? 1) === 0,
        titleCopyAlignsComposer:
          titleCopyRect && composerRect
            ? Math.abs(titleCopyRect.left - composerRect.left) <= 1.5
            : false,
        titleIconProtrudes:
          titleIconRect && titleCopyRect
            ? titleIconRect.right <= titleCopyRect.left + 1
            : false,
        titleGutterFitsIcon:
          titleCopyRect && titleIconRect
            ? titleCopyRect.left - emptyRect.left >= titleIconRect.width - 1 &&
              emptyRect.right - titleCopyRect.right >= titleIconRect.width - 1
            : false,
        titleGutterFitsExtraIcon:
          titleCopyRect && titleIconRect
            ? titleCopyRect.left - emptyRect.left >=
                titleIconRect.width * 2 - 1 &&
              emptyRect.right - titleCopyRect.right >=
                titleIconRect.width * 2 - 1
            : false,
        titleAboveCards:
          titleRect && cardRect ? titleRect.bottom < cardRect.top : false,
        scrollMaskNone: scrollStyle
          ? scrollStyle.maskImage === "none" &&
            scrollStyle.getPropertyValue("-webkit-mask-image") === "none"
          : false,
        titlebarTransparent: titlebarStyle
          ? titlebarStyle.backgroundColor === "rgba(0, 0, 0, 0)"
          : false,
        workspaceTransparent: workspaceStyle
          ? workspaceStyle.backgroundColor === "rgba(0, 0, 0, 0)"
          : false,
        workspaceLeftRadiusPreserved: workspaceStyle
          ? Number.parseFloat(workspaceStyle.borderTopLeftRadius) > 0 &&
            Number.parseFloat(workspaceStyle.borderBottomLeftRadius) > 0
          : false,
      };
    });
  assert(
    emptyStateLayout.cardCount === 4 &&
      emptyStateLayout.emptyWidth >= 900 &&
      emptyStateLayout.railViewportAligned &&
      emptyStateLayout.railViewportWidth >= emptyStateLayout.emptyWidth - 2 &&
      emptyStateLayout.railScrollWidth > emptyStateLayout.railViewportWidth &&
      emptyStateLayout.railGridWidth > emptyStateLayout.railViewportWidth &&
      emptyStateLayout.scrollOverflowY === "hidden" &&
      emptyStateLayout.scrollHeight <=
        emptyStateLayout.scrollClientHeight + 1 &&
      emptyStateLayout.fluidCovers &&
      emptyStateLayout.fluidGrayCoverageMax >= 0.4 &&
      emptyStateLayout.fluidGrayCoverageMax <= 0.66 &&
      emptyStateLayout.fluidAverageToneMin >= 210 &&
      emptyStateLayout.fluidAverageToneMin <= 235 &&
      emptyStateLayout.fluidMinToneMin >= 150 &&
      emptyStateLayout.fluidMinToneMin <= 205 &&
      emptyStateLayout.fluidVisibleCoverageMin >= 0.03 &&
      emptyStateLayout.fluidActiveCellsMin >= 3 &&
      emptyStateLayout.cardHasTintedGlass &&
      emptyStateLayout.cardIconCount === 0 &&
      emptyStateLayout.cardGraphicCount === 0 &&
      emptyStateLayout.cardWidth >= 190 &&
      emptyStateLayout.cardWidth <= 230 &&
      emptyStateLayout.cardHeight >= 240 &&
      emptyStateLayout.cardDescriptionBelowTitle &&
      emptyStateLayout.cardMetaBeforeTitle &&
      emptyStateLayout.momentAboveTitle &&
      emptyStateLayout.momentShowsTime &&
      emptyStateLayout.titleFontSize <= 48 &&
      emptyStateLayout.titleStartsHigh &&
      emptyStateLayout.titleIconAligned &&
      emptyStateLayout.titleIconUsesAssetImage &&
      emptyStateLayout.titleCopyAlignsComposer &&
      emptyStateLayout.titleIconProtrudes &&
      emptyStateLayout.titleGutterFitsIcon &&
      emptyStateLayout.titleGutterFitsExtraIcon &&
      emptyStateLayout.titleAboveCards &&
      emptyStateLayout.fluidTopLeftRadius > 0 &&
      emptyStateLayout.fluidBottomLeftRadius > 0 &&
      emptyStateLayout.scrollMaskNone &&
      emptyStateLayout.titlebarTransparent &&
      emptyStateLayout.workspaceTransparent &&
      emptyStateLayout.workspaceLeftRadiusPreserved,
    `new chat empty state should use coherent DS suggestion cards: ${JSON.stringify(emptyStateLayout)}`,
  );
  await expectLocatorCount(
    page,
    rightPanelToggleSelector,
    0,
    "right panel toggle should be hidden on draft new chat",
  );
  await patchSettings({ main_screen_theme: "silk" });
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.locator(testClass("mac-window")).evaluate(
    (root) =>
      root.classList.contains("main-screen-theme-silk") ||
      new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (root.classList.contains("main-screen-theme-silk")) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["class"],
        });
        setTimeout(() => {
          observer.disconnect();
          resolve(root.classList.contains("main-screen-theme-silk"));
        }, 1000);
      }),
  );
  await page
    .locator(testClass("new-chat-empty-state"))
    .waitFor({ state: "visible" });
  const silkFluidState = await page
    .locator(testClass("new-chat-fluid-gradient"))
    .evaluate(async (canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { changedCoverageMax: 0, spreadMax: 0 };
      }
      const webgl = canvas.getContext("webgl");
      const width = webgl?.drawingBufferWidth ?? canvas.width;
      const height = webgl?.drawingBufferHeight ?? canvas.height;
      const samples: Array<{ changedCoverage: number; spread: number }> = [];
      for (let sample = 0; sample < 5; sample += 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const pixels = new Uint8Array(width * height * 4);
        webgl?.readPixels(
          0,
          0,
          width,
          height,
          webgl.RGBA,
          webgl.UNSIGNED_BYTE,
          pixels,
        );
        let changedPixels = 0;
        let minTone = 255;
        let maxTone = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index] ?? 255;
          const green = pixels[index + 1] ?? 255;
          const blue = pixels[index + 2] ?? 255;
          const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          if (luminance <= 246) changedPixels += 1;
          minTone = Math.min(minTone, luminance);
          maxTone = Math.max(maxTone, luminance);
        }
        const total = pixels.length / 4;
        samples.push({
          changedCoverage: changedPixels / total,
          spread: maxTone - minTone,
        });
      }
      return {
        changedCoverageMax: Math.max(
          ...samples.map((sample) => sample.changedCoverage),
        ),
        spreadMax: Math.max(...samples.map((sample) => sample.spread)),
      };
    });
  assert(
    silkFluidState.changedCoverageMax >= 0.12 && silkFluidState.spreadMax >= 18,
    `silk main screen theme should render visible monochrome folds: ${JSON.stringify(silkFluidState)}`,
  );
  await patchSettings({
    main_screen_theme: "bloom",
    main_screen_theme_preset: "monochrome",
  });
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page
    .locator(testClass("new-chat-empty-state"))
    .waitFor({ state: "visible" });
  const composerInput = page.locator(`${testClass("composer-card")} textarea`);
  const draftComposerBox = await page
    .locator(testClass("composer-card"))
    .boundingBox();
  assert(draftComposerBox, "draft composer card is missing");
  await page.mouse.click(
    draftComposerBox.x + Math.min(320, draftComposerBox.width - 24),
    draftComposerBox.y + 24,
  );
  await page.keyboard.type("composer focus");
  const composerFocusState = await composerInput.evaluate((element) => ({
    focused: document.activeElement === element,
    value: (element as HTMLTextAreaElement).value,
  }));
  assert(
    composerFocusState.focused && composerFocusState.value === "composer focus",
    `composer-card-click-focuses-textarea failed: ${JSON.stringify(composerFocusState)}`,
  );
  await page.waitForTimeout(900);
  const composerFocusAfterPoll = await composerInput.evaluate((element) => ({
    focused: document.activeElement === element,
    value: (element as HTMLTextAreaElement).value,
  }));
  assert(
    composerFocusAfterPoll.focused &&
      composerFocusAfterPoll.value === "composer focus",
    `composer-focus-survives-summary-poll failed: ${JSON.stringify(composerFocusAfterPoll)}`,
  );
  await composerInput.fill("");
  await composerInput.fill("IME draft");
  await composerInput.dispatchEvent("compositionstart");
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(240);
  await expectLocatorCount(
    page,
    testClasses("message", "user"),
    0,
    "cmd enter should not send while IME composition is active",
  );
  await composerInput.dispatchEvent("compositionend");
  await composerInput.fill("## Smoke request\n\n- show markdown");
  const messageAcceptedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${server.url}messages` &&
      response.request().method() === "POST" &&
      response.status() === 202,
  );
  await page.keyboard.press("Meta+Enter");
  await page
    .locator(testClasses("message", "user"), { hasText: "## Smoke request" })
    .waitFor({ state: "visible", timeout: 1200 });
  await messageAcceptedResponse;
  await expectLocatorCount(
    page,
    `${testClass("composer-wrap")} ${testClass("turn-activity-panel")}`,
    0,
    "turn activity must not render in composer",
  );
  const timelineActivity = page.locator(
    `${testClasses("message", "assistant", "turn-activity-message")} ${testClass("turn-activity-panel")}`,
  );
  await timelineActivity.waitFor({
    state: "visible",
    timeout: turnActivityTimeoutMs,
  });
  await page
    .locator(testClass("assistant-mark-active"))
    .waitFor({ state: "visible", timeout: turnActivityTimeoutMs });
  const turnActivityText = await timelineActivity.innerText();
  const pendingLabels = appCopy.conversation.work.pendingStateLabels;
  assert(
    turnActivityText.includes(pendingLabels.thinking) ||
      turnActivityText.includes(pendingLabels.session_starting) ||
      turnActivityText.includes("Bash"),
    `turn-activity-during-send failed: ${turnActivityText}`,
  );
  releaseSmokeResponderProgress?.();
  const timelineWorkActivity = page.locator(
    `${testClasses("message", "assistant", "turn-activity-message")} ${testClasses("turn-activity-panel", "turn-work-panel")}`,
    { hasText: "Bash" },
  );
  await timelineWorkActivity.waitFor({
    state: "visible",
    timeout: turnActivityTimeoutMs,
  });
  const activityButton = timelineWorkActivity
    .getByRole("button", { name: /Bash/u })
    .first();
  await activityButton.focus();
  await page.keyboard.press("Enter");
  const expanded = await activityButton.getAttribute("aria-expanded");
  assert(expanded === "true", "turn activity keyboard expands details");
  const activityDetails = timelineWorkActivity
    .locator(testClass("turn-activity-details"), { hasText: "bun test" })
    .first();
  await activityDetails.waitFor({
    state: "visible",
    timeout: turnActivityTimeoutMs,
  });
  const activityDetailsColor = await activityDetails.evaluate((element) => {
    const block = element.closest("[data-test-class~='turn-work-block']");
    const probe = document.createElement("span");
    probe.style.color = "var(--work-activity-muted-text)";
    (block ?? element).appendChild(probe);
    const mutedColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      color: getComputedStyle(element).color,
      mutedColor,
    };
  });
  assert(
    activityDetailsColor.color === activityDetailsColor.mutedColor,
    `turn activity detail content should use muted work tone: ${JSON.stringify(activityDetailsColor)}`,
  );
  const activityButtonStyle = await activityButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      alignItems: style.alignItems,
      borderTopColor: style.borderTopColor,
      borderTopWidth: style.borderTopWidth,
      display: style.display,
      maxWidth: style.maxWidth,
    };
  });
  assert(
    activityButtonStyle.display === "grid" &&
      activityButtonStyle.alignItems === "center" &&
      activityButtonStyle.borderTopWidth === "1px" &&
      activityButtonStyle.maxWidth !== "none" &&
      activityButtonStyle.borderTopColor !== "rgba(0, 0, 0, 0)",
    `turn activity tool button should be outlined, capped, and center-aligned: ${JSON.stringify(activityButtonStyle)}`,
  );
  screenshots.push(await screenshot(page, "turn-activity-timeline.png"));
  releaseSmokeResponderReply?.();
  await page
    .locator(`${testClass("markdown-document")} h2`, {
      hasText: "Butler reply",
    })
    .waitFor({ state: "visible", timeout: 10_000 });
  const assistantMessageForContextMenu = page
    .locator(testClasses("message", "assistant"), { hasText: "Butler reply" })
    .last();
  const inlineMarkdownImage = assistantMessageForContextMenu
    .locator(testClass("markdown-inline-image"))
    .first();
  await inlineMarkdownImage.waitFor({ state: "visible", timeout: 5000 });
  const inlineMarkdownImageState = await inlineMarkdownImage.evaluate(
    async (element) => {
      const image = element as HTMLImageElement;
      if (!image.complete) {
        await new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 1200);
        });
      }
      const imageBox = image.getBoundingClientRect();
      const documentBox = image
        .closest('[data-test-class~="markdown-document"]')
        ?.getBoundingClientRect();
      return {
        complete: image.complete,
        documentWidth: documentBox?.width ?? 0,
        naturalWidth: image.naturalWidth,
        src: image.currentSrc || image.src,
        width: imageBox.width,
      };
    },
  );
  assert(
    inlineMarkdownImageState.complete &&
      inlineMarkdownImageState.naturalWidth > 0 &&
      inlineMarkdownImageState.src.includes("/message-files/file-") &&
      inlineMarkdownImageState.width <=
        inlineMarkdownImageState.documentWidth * 0.31,
    `markdown inline image should render from message files and stay bounded: ${JSON.stringify(inlineMarkdownImageState)}`,
  );
  await assistantMessageForContextMenu.click({ button: "right" });
  await page
    .locator('[data-slot="context-menu-content"]')
    .waitFor({ state: "visible", timeout: 1200 });
  const messageContextMenuGlass = await page
    .locator('[data-slot="context-menu-content"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
      };
    });
  assert(
    messageContextMenuGlass.background === composerGlass.background &&
      messageContextMenuGlass.borderColor === composerGlass.borderColor &&
      messageContextMenuGlass.backdrop.includes("blur"),
    `conversation-context-menu-liquid-glass-tokenized failed: ${JSON.stringify(messageContextMenuGlass)}`,
  );
  await page.getByRole("menuitem", { name: appCopy.common.copy }).click();
  await page
    .locator('[data-slot="context-menu-content"]')
    .waitFor({ state: "hidden", timeout: 1200 });
  const singleWorkContainer = page
    .locator(testClass("turn-work-collapsed"), {
      hasText: "로컬 테스트 명령을 실행합니다.",
    })
    .first();
  const singleWorkButton = singleWorkContainer.getByRole("button").first();
  await singleWorkButton.waitFor({
    state: "visible",
    timeout: turnActivityTimeoutMs,
  });
  const singleWorkTriggerText = (await singleWorkButton.innerText())
    .replace(/\s+/g, " ")
    .trim();
  assert(
    singleWorkTriggerText === "로컬 테스트 명령을 실행합니다.",
    `single collapsed work button should use the public work summary: ${singleWorkTriggerText}`,
  );
  if ((await singleWorkButton.getAttribute("aria-expanded")) !== "true") {
    await singleWorkButton.click();
  }
  await singleWorkContainer
    .locator(testClass("turn-work-tool-row"))
    .first()
    .waitFor({ state: "visible", timeout: turnActivityTimeoutMs });
  const singleExpandedHeaders = singleWorkContainer.locator(
    testClass("turn-work-block-header"),
  );
  const singleExpandedHeaderCount = await singleExpandedHeaders.count();
  assert(
    singleExpandedHeaderCount === 1,
    `single expanded work history should show one full work message, got ${singleExpandedHeaderCount}`,
  );
  const singleExpandedHeaderText = (
    await singleExpandedHeaders.first().innerText()
  )
    .replace(/\s+/g, " ")
    .trim();
  assert(
    singleExpandedHeaderText === "로컬 테스트 명령을 실행합니다.",
    `single expanded work history should include the full work message: ${singleExpandedHeaderText}`,
  );
  const workTimelineState = await singleWorkContainer.evaluate((element) => {
    const disclosure = element.querySelector("[data-surface]");
    const block = element.querySelector("[data-test-class~='turn-work-block']");
    const header = element.querySelector(
      "[data-test-class~='turn-work-block-header']",
    );
    const marker = block?.querySelector("[data-slot='work-activity-marker']");
    const headerIcon = block?.querySelector(
      "[data-slot='work-activity-icon'] svg",
    );
    const description = block?.querySelector(
      "[data-slot='work-activity-description']",
    );
    const tool = element.querySelector(
      "[data-test-class~='turn-work-tool-row']",
    );
    const disclosureBox = disclosure?.getBoundingClientRect();
    const markerBox = marker?.getBoundingClientRect();
    const headerBox = header?.getBoundingClientRect();
    const descriptionBox = description?.getBoundingClientRect();
    const toolBox = tool?.getBoundingClientRect();
    const result = element.nextElementSibling as HTMLElement | null;
    const resultBox = result?.getBoundingClientRect();
    const titleWeight = header ? getComputedStyle(header).fontWeight : "";
    const titleWhiteSpace = header ? getComputedStyle(header).whiteSpace : "";
    const titleColor = header ? getComputedStyle(header).color : "";
    const descriptionColor = description
      ? getComputedStyle(description).color
      : "";
    const triggerCursor = disclosure
      ? getComputedStyle(
          disclosure.querySelector("[role='button']") ?? disclosure,
        ).cursor
      : "";
    const disclosureBackground = disclosure
      ? getComputedStyle(disclosure).backgroundColor
      : "";
    const toolStyle = tool
      ? getComputedStyle(tool.firstElementChild ?? tool)
      : null;
    const readTokenColor = (token: string) => {
      if (!block) return "";
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      block.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const secondaryColor = readTokenColor("--text-secondary");
    const mutedColor = readTokenColor("--work-activity-muted-text");
    return {
      disclosureBackground,
      disclosureSurface: disclosure?.getAttribute("data-surface"),
      headerX: headerBox?.x ?? 0,
      hasHeaderIcon: Boolean(headerIcon),
      markerCenterX: markerBox ? markerBox.x + markerBox.width / 2 : Number.NaN,
      markerSize: markerBox?.width ?? 0,
      descriptionX: descriptionBox?.x ?? 0,
      resultGap:
        resultBox && disclosureBox
          ? resultBox.y - (disclosureBox.y + disclosureBox.height)
          : Number.NaN,
      toolX: toolBox?.x ?? 0,
      descriptionColor,
      titleColor,
      triggerCursor,
      titleWeight,
      titleWhiteSpace,
      titleUsesSecondary: titleColor === secondaryColor,
      descriptionUsesMuted: descriptionColor === mutedColor,
      toolUsesMuted: toolStyle?.color === mutedColor,
      toolBorderColor: toolStyle?.borderTopColor ?? "",
      toolMaxWidth: toolStyle?.maxWidth ?? "",
      disclosureWidth: disclosureBox?.width ?? 0,
    };
  });
  assert(
    workTimelineState.disclosureSurface === "plain" &&
      /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/u.test(
        workTimelineState.disclosureBackground,
      ),
    `completed work disclosure should stay visually plain: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    Number(workTimelineState.titleWeight) <= 500,
    `work timeline title should not be bold: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    workTimelineState.titleWhiteSpace === "normal",
    `work timeline title should wrap instead of overflowing: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    workTimelineState.descriptionColor !== workTimelineState.titleColor,
    `work timeline body should use a quieter tone than the title: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    workTimelineState.titleUsesSecondary &&
      workTimelineState.descriptionUsesMuted &&
      workTimelineState.toolUsesMuted,
    `work timeline text should step down to secondary and muted tones: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    workTimelineState.resultGap >= 14,
    `answer body should have breathing room after work history: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    workTimelineState.triggerCursor === "pointer",
    `clickable work history trigger should use a pointer cursor: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    !workTimelineState.hasHeaderIcon &&
      workTimelineState.markerSize >= 6 &&
      Number.isFinite(workTimelineState.markerCenterX),
    `work timeline should use a dot marker instead of a decorative fixed header icon: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    Math.abs(workTimelineState.headerX - workTimelineState.descriptionX) <= 1 &&
      Math.abs(workTimelineState.headerX - workTimelineState.toolX) <= 1,
    `work timeline content starts should align: ${JSON.stringify(workTimelineState)}`,
  );
  assert(
    workTimelineState.toolMaxWidth !== "none" &&
      workTimelineState.toolBorderColor !== "rgba(0, 0, 0, 0)",
    `toolchain row should be outlined and capped: ${JSON.stringify(workTimelineState)}`,
  );
  screenshots.push(await screenshot(page, "cmd-enter-markdown-send.png"));
  const showSidebarForProjectMenu = page.getByRole("button", {
    name: "Show sidebar",
  });
  if (await showSidebarForProjectMenu.isVisible()) {
    await showSidebarForProjectMenu.click();
    await page.waitForTimeout(320);
  }
  await page
    .getByRole("button", { name: appCopy.sidebar.projectMenu })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: appCopy.sessionActions.rename })
    .waitFor({ state: "visible" });
  await page.mouse.click(80, 80);
  await page.waitForTimeout(400);
  await expectLocatorCount(
    page,
    "[role='menuitem']:visible",
    0,
    "project menu should close on outside click",
  );
  await closeBlockingOverlays(page);
  await page
    .locator(testClass("project-session-row"))
    .first()
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: appCopy.sessionActions.rename })
    .waitFor({ state: "visible" });
  const sessionRowMenuGlass = await page
    .locator('[data-slot="dropdown-menu-content"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
        menuTop: element.getBoundingClientRect().top,
        titlebarSafeTop:
          Number.parseFloat(rootStyle.getPropertyValue("--titlebar-height")) +
          Number.parseFloat(rootStyle.getPropertyValue("--space-sm")),
      };
    });
  assert(
    sessionRowMenuGlass.background === composerGlass.background &&
      sessionRowMenuGlass.borderColor === composerGlass.borderColor &&
      sessionRowMenuGlass.backdrop.includes("blur"),
    `session-row-context-menu-liquid-glass-tokenized failed: ${JSON.stringify(sessionRowMenuGlass)}`,
  );
  await page.keyboard.press("Escape");
  await page
    .locator('[data-slot="dropdown-menu-content"]')
    .waitFor({ state: "hidden", timeout: 1200 });
  await page
    .getByRole("button", { name: appCopy.sidebar.projectMenu })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: appCopy.sessionActions.rename })
    .click();
  await page.locator(testClass("modal-card")).waitFor({ state: "visible" });
  screenshots.push(await screenshot(page, "project-rename-modal.png"));
  await page
    .getByRole("textbox", { name: appCopy.sidebar.projectName })
    .fill("butler smoke");
  await page.getByRole("button", { name: appCopy.common.save }).click();
  await page.getByText("butler smoke").waitFor({ state: "visible" });
  await page.locator(testClass("modal-card")).waitFor({ state: "hidden" });
  await page
    .locator('[data-slot="dialog-overlay"]')
    .waitFor({ state: "hidden" });
  screenshots.push(await screenshot(page, "project-rename-real-app.png"));

  await page
    .locator(`${testClass("custom-titlebar")} ${testClass("project-controls")}`)
    .getByRole("button", { name: appCopy.sessionActions.menuLabel })
    .click();
  await page
    .locator('[data-slot="dropdown-menu-content"]')
    .waitFor({ state: "visible" });
  const sessionMenuGlass = await page
    .locator('[data-slot="dropdown-menu-content"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        backdrop:
          style.backdropFilter ||
          style.getPropertyValue("-webkit-backdrop-filter"),
        menuTop: element.getBoundingClientRect().top,
        titlebarSafeTop:
          Number.parseFloat(rootStyle.getPropertyValue("--titlebar-height")) +
          Number.parseFloat(rootStyle.getPropertyValue("--space-sm")),
      };
    });
  assert(
    sessionMenuGlass.background === composerGlass.background &&
      sessionMenuGlass.borderColor === composerGlass.borderColor &&
      sessionMenuGlass.backdrop.includes("blur"),
    `titlebar-session-menu-liquid-glass-tokenized failed: ${JSON.stringify(sessionMenuGlass)}`,
  );
  assert(
    sessionMenuGlass.menuTop >= sessionMenuGlass.titlebarSafeTop - 1,
    `titlebar menu content should stay below titlebar safe area: ${JSON.stringify(sessionMenuGlass)}`,
  );
  await clickConversationAwayFromMenus(page);
  await page.waitForTimeout(400);

  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`${server.url}?visual=components`, {
    waitUntil: "networkidle",
  });
  await page.locator(testClass("composer-card")).waitFor({ state: "visible" });
  screenshots.push(await screenshot(page, "compact-components.png"));

  await page.goto(`${server.url}?visual=thinking-mark`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Idle" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Working" }).click();
  await page.locator("#thinking-mark-size").fill("300");
  await page.waitForTimeout(700);
  await expectLocatorCount(
    page,
    "canvas",
    2,
    "thinking mark should render dark and light canvas samples",
  );
  await expectLocatorCount(
    page,
    "svg",
    2,
    "thinking mark should render dark and light SVG icon samples",
  );
  const thinkingCanvasBox = await page.locator("canvas").first().boundingBox();
  assert(thinkingCanvasBox, "thinking mark canvas is missing");
  assert(
    Math.abs(thinkingCanvasBox.width - 300) <= 1,
    `thinking mark should resize to 300px, got ${thinkingCanvasBox.width}`,
  );
  screenshots.push(await screenshot(page, "thinking-mark-components.png"));

  console.log(
    JSON.stringify({
      ok: true,
      service: "butler-app-layout-smoke",
      checks: [
        "served-visual-harness",
        "real-playwright-screenshots",
        "conversation-body-width-matches-composer",
        "user-bubble-content-sized",
        "conversation-end-near-composer",
        "composer-liquid-glass-surface",
        "composer-fixed-edge-gradient",
        "composer-toolbar-subtle-divider",
        "worker-panel-inside-composer-card",
        "worker-panel-identity-fixed",
        "assistant-footer-copy-duration-time",
        "assistant-footer-semantic-time",
        "composer-ready-status-absent",
        "context-hover-popover-visible",
        "context-popover-titlebar-safe",
        "context-detail-chart-visible",
        "context-legend-swatch-label-aligned",
        "context-legend-swatch-structural-alignment",
        "context-legend-value-caption-sized",
        "context-legend-meta-top-aligned",
        "context-legend-horizontal-scroll-absent",
        "context-working-copy-stacked",
        "context-legend-scrolls",
        "context-legend-scrollbar-gutter",
        "context-legend-content-aligns-overview",
        "summary-progress-inspector-bounded",
        "fresh-left-sidebar-collapsed",
        "left-toggle-titlebar-positioned",
        "browser-chrome-traffic-reserve-zero",
        "browser-sidebar-toggle-flush-left",
        "sidebar-hover-highlight",
        "sidebar-unified-row-height",
        "project-session-no-indent",
        "project-group-not-child-active",
        "active-sidebar-row-aria-current",
        "project-row-click-toggles-collapse",
        "project-row-click-reopens",
        "project-dashboard-activity-visible",
        "project-dashboard-ledger-document-modal",
        "left-panel-resizes",
        "left-panel-keyboard-resizes",
        "right-panel-resizes",
        "right-panel-column-animates-on-close",
        "right-panel-closes-with-slide",
        "right-panel-content-width-stable-while-closing",
        "right-panel-remains-mounted-closed",
        "right-panel-toggle-open-ghostless",
        "right-panel-toggle-tooltip-horizontal",
        "titlebar-tooltip-focus-restore-suppressed",
        "narrow-right-panel-visible",
        "narrow-right-panel-tabs-below-titlebar",
        "narrow-right-panel-titlebar-close-visible",
        "narrow-right-panel-titlebar-draggable",
        "narrow-right-panel-left-toggle-hidden",
        "narrow-right-panel-auto-collapses-left-state",
        "narrow-titlebar-new-chat-visible",
        "left-resize-below-min-collapses",
        "sidebar-collapses-to-zero",
        "left-sidebar-column-animates-on-close",
        "plan-switch-absent",
        "composer-control-hover-pill",
        "composer-control-hover-clipped",
        "attachment-picker-visible",
        "attachment-picker-all-files",
        "png-attachment-chip",
        "permission-popover-closes-outside",
        "permission-mode-updates-icon-and-color",
        "composer-control-button-gap-tokenized",
        "composer-control-button-alignment",
        "composer-control-icon-wrapper-sized",
        "permission-trigger-no-chevron",
        "model-popover-closes-outside",
        "model-menu-selects",
        "model-trigger-no-chevron",
        "project-menu-closes-outside",
        "artifact-detail-opens",
        "settings-replaces-app-sidebar",
        "settings-titlebar-draggable",
        "settings-detail-drag-after-scroll",
        "settings-model-rules-visible",
        "settings-context-limit-updates",
        "settings-context-limit-described",
        "settings-main-theme-options",
        "settings-main-theme-silk-option",
        "settings-silk-theme-detail-absent",
        "settings-bloom-colors-circular",
        "settings-unsupported-provider-presets-hidden",
        "settings-back-closes",
        "settings-escape-closes",
        "select-liquid-glass-tokenized",
        "dialog-content-titlebar-safe",
        "dark-theme-surfaces-tokenized",
        "dark-titlebar-text-tokenized",
        "dark-permission-menu-tokenized",
        "context-popover-theme-tokenized",
        "tooltip-theme-tokenized",
        "tooltip-titlebar-safe",
        "tooltip-reappears-after-second-hover",
        "popover-liquid-glass-tokenized",
        "light-theme-sidebar-tokenized",
        "light-titlebar-text-tokenized",
        "new-chat-fluid-covers-titlebar",
        "new-chat-fluid-palette-tone-preserved",
        "new-chat-fluid-liquid-visible",
        "new-chat-silk-fluid-visible",
        "new-chat-moment-title-flow",
        "new-chat-moment-time-visible",
        "new-chat-tall-tinted-cards",
        "new-chat-card-ordinals-only",
        "new-chat-scroll-unmasked",
        "new-chat-vertical-scroll-absent",
        "new-chat-start-position-high",
        "new-chat-extra-icon-gutter",
        "new-chat-left-radius-preserved",
        "right-toggle-hidden-when-empty",
        "right-toggle-hidden-on-draft-new-chat",
        "composer-card-click-focuses-textarea",
        "composer-focus-survives-summary-poll",
        "cmd-enter-blocks-during-composition",
        "cmd-enter-send-optimistic",
        "turn-activity-during-send",
        "turn-activity-tool-details-expand",
        "turn-activity-tool-button-outline-centered",
        "single-work-message-visible",
        "pending-turn-does-not-flash-stale-tool-history",
        "assistant-butler-mark-visible",
        "markdown-response-rendered",
        "markdown-inline-image-rendered",
        "markdown-inline-image-bounded",
        "conversation-context-menu-liquid-glass-tokenized",
        "composer-worker-stack-visible",
        "real-app-project-rename-modal",
        "session-row-context-menu-liquid-glass-tokenized",
        "titlebar-session-menu-liquid-glass-tokenized",
        "titlebar-menu-content-titlebar-safe",
        "thinking-mark-state-toggle",
        "thinking-mark-resizable",
        "thinking-mark-svg-icon",
      ],
      screenshots,
    }),
  );
} finally {
  await browser.close();
  server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
