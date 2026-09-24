import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createTestAppServer as createAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import {
  readFirstChatOnboardingState,
  writeFirstChatOnboardingState,
} from "../../packages/butler-agent/src/personalization/onboarding.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import {
  FIRST_RUN_STORAGE_KEY,
  firstRunCompleteState,
} from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";

// Focused smoke for the Phase 2 screen contracts in
// SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM.
const tempDir = mkdtempSync(join(tmpdir(), "butler-screen-contracts-smoke-"));
writeFirstChatOnboardingState(tempDir, {
  ...readFirstChatOnboardingState(tempDir),
  status: "complete",
  completed_at: new Date().toISOString(),
});
const server = createAppServer({
  dbPath: join(tempDir, "screen-contracts.sqlite"),
  butlerData: tempDir,
  uiRoot: resolve("packages/butler-app/client/ui/dist"),
  port: 0,
  bridgeMode: "external",
});
const testClass = (name: string) => `[data-test-class~="${name}"]`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function openApp(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: FIRST_RUN_STORAGE_KEY, value: JSON.stringify(firstRunCompleteState("en")) },
  );
  await page.goto(server.url, { waitUntil: "load" });
  await page.locator(testClass("composer-card")).waitFor({ state: "visible" });
}

async function assertMediumDrawerKeepsWorkspaceVisible(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(320);
  const show = page.getByRole("button", { name: appCopy.titlebar.showLeftPanel });
  if (await show.count()) await show.first().click();
  await page.waitForTimeout(400);
  const sidebar = await page.locator(testClass("sidebar-slot")).boundingBox();
  const workspace = await page.locator(testClass("workspace")).boundingBox();
  assert(sidebar && workspace, "sidebar and workspace boxes are required");
  assert(
    sidebar.width > 0 && sidebar.width <= 336,
    `medium drawer sidebar should be bounded (<=336px): ${JSON.stringify(sidebar)}`,
  );
  assert(
    workspace.x < 900 - 200,
    `workspace should stay visible beside the medium drawer: ${JSON.stringify(workspace)}`,
  );
}

async function assertInspectorContentStartsAtTop(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.url}?visual=components`, { waitUntil: "load" });
  const inspector = page.locator(testClass("right-inspector-open"));
  await inspector.waitFor({ state: "visible" });
  const layout = await inspector.evaluate((element) => {
    const content = [...element.querySelectorAll<HTMLElement>("div")].find(
      (candidate) => getComputedStyle(candidate).alignContent === "start"
        && getComputedStyle(candidate).display === "grid"
        && candidate.scrollHeight <= candidate.clientHeight + 1
        && candidate.children.length > 0,
    );
    if (!content) return null;
    const first = content.firstElementChild!.getBoundingClientRect();
    return {
      gap: first.top - content.getBoundingClientRect().top,
      firstHeight: first.height,
      contentHeight: content.clientHeight,
    };
  });
  assert(layout, "inspector content should pack rows at the start");
  assert(
    layout.gap <= 24 && layout.firstHeight < layout.contentHeight,
    `inspector rows should start at the top without stretching: ${JSON.stringify(layout)}`,
  );
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openApp(page);
  await assertMediumDrawerKeepsWorkspaceVisible(page);
  await assertInspectorContentStartsAtTop(page);
  console.log("app screen contracts smoke passed");
} finally {
  await browser.close();
  server.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
