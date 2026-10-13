// Offline native Settings and approval-card visual/functional acceptance.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";

const output = process.env.BUTLER_ACCESS_EVIDENCE;
assert(output, "BUTLER_ACCESS_EVIDENCE required");
const before = process.env.BUTLER_ACCESS_BEFORE_UI;
const stage = before ? "before" : "after";
mkdirSync(join(output, stage), { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(before ?? "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
let captures = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await server.signIn(page);
  await page.addInitScript(() => {
    const kind = new URLSearchParams(location.search).get("kind");
    if (!kind) return;
    const target = "https://example.com/?q=outside-content";
    const approval = kind === "schedule"
      ? { action_kind: "manage_schedule", schedule_access_mode: "auto", targets: [{ kind: "schedule", path: "automation:create:nightly" }],
        operation: { tool: "create_automation", access: "change", targets: ["automation:create:nightly"] } }
      : kind === "web"
        ? { action_kind: "web_request", targets: [{ kind: "other", path: target }],
          operation: { tool: "web_read", access: "read_only", targets: [target] } }
        : { action_kind: "network_command", targets: [{ kind: "folder", path: "workspace" }],
          operation: { tool: "run_command_remote_observation", access: "change", targets: ["workspace"], command: "curl https://example.com/" } };
    Object.assign(window, { butlerApprovalFixture: { ...approval, count: 1, risk: "high", examples: [] },
      butlerApprovalReason: kind === "schedule" ? "Apply one reviewed effect" : "authority.taintReason" });
  });
  for (const theme of ["light", "dark"] as const) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      access_mode: "ask_except_reads", schedule_access_mode: "auto",
      wallpaper: { source: { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
    await page.goto(`${server.url}?settings=general`);
    const chat = page.locator('[data-setting-id="access-mode"]');
    await chat.waitFor();
    assert((await chat.innerText()).includes("먼저 확인"));
    const schedule = page.locator('[data-setting-id="schedule-access-mode"]');
    assert.equal(await schedule.count(), before ? 0 : 1);
    if (!before) assert((await schedule.innerText()).includes("알아서 진행"));
    const permissions = page.locator('[data-settings-section-id="default-permission"]');
    await permissions.evaluate(node => node.scrollIntoView({ block: "center" }));
    await capture(page, `settings-${theme}-${width}.png`);
    captures++;
    if (!before) {
      await schedule.getByRole("button").click();
      const choices = page.locator('[data-slot="option-menu-item"]');
      assert.equal(await choices.count(), 5);
      assert((await choices.first().innerText()).includes("알아서 진행"));
      assert((await choices.first().innerText()).includes("권장"));
      await capture(page, `schedule-menu-${theme}-${width}.png`);
      captures++;
      await choices.filter({ hasText: "읽기 전용" }).click();
      await page.waitForFunction(() => document.querySelector('[data-setting-id="schedule-access-mode"]')?.textContent?.includes("읽기 전용"));
      const deadline = Date.now() + 5000;
      while ((await server.api<{ settings?: { schedule_access_mode?: string }; schedule_access_mode?: string }>("/settings")).schedule_access_mode !== "read_only") {
        assert(Date.now() < deadline, "schedule default persisted");
        await new Promise(done => setTimeout(done, 50));
      }
    }
    for (const lang of ["ko", "en"] as const) for (const kind of ["schedule", "web", "taint"]) {
      await page.goto(`${server.url}?visual=components&surface=activity-layout&approval=1&state=completed&theme=${theme}&lang=${lang}&kind=${kind}`);
      const card = page.locator('[data-test-class="composer-authority-decision"]');
      await card.waitFor();
      const copy = getAppCopy(lang === "ko" ? "ko-KR" : "en-US");
      const text = await card.innerText();
      if (!before) {
        if (kind === "schedule") {
          assert(text.includes(copy.interfaceTemplates.approvalRequest.manageSchedule.create));
          assert(text.includes(copy.interfaceTemplates.approvalRequest.scheduleMode(copy.permissions.auto)));
        } else {
          assert(text.includes(copy.interfaceTemplates.approvalRequest.taintReason));
          if (kind === "web") {
            assert(text.includes(copy.interfaceTemplates.approvalRequest.webRequest));
            assert(text.includes("https://example.com/?q=outside-content"));
          }
        }
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await capture(page, `${kind}-${lang}-${theme}-${width}.png`);
      captures++;
    }
  }
  console.log(JSON.stringify({ stage, captures, liveModelCalls: 0 }));
} finally { await browser.close(); await server.stop(); }

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  await page.screenshot({ path: join(output!, stage, name) });
}
