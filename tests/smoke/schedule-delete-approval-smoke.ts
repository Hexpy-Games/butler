// Offline public approval-card harness; no provider or owner data access.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser";

const output = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(output, "BUTLER_BROWSER_EVIDENCE required");
mkdirSync(output, { recursive: true });
const stage = process.env.BUTLER_SCHEDULE_APPROVAL_STAGE ?? "after";
const root = resolve(process.env.BUTLER_SMOKE_RENDERER_DIST ?? "packages/butler-app/client/ui/dist");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await launchSmokeBrowser();
let checked = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "UTC" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ stage }) => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("kind")!;
    const lang = params.get("lang");
    const create = kind === "create";
    const target = `automation:${create ? "create" : "delete_automation"}:internal-schedule-id`;
    (window as Window & { butlerApprovalFixture?: unknown }).butlerApprovalFixture = {
      action_kind: "manage_schedule", count: 1, risk: "medium", examples: [],
      targets: [{ kind: "schedule", path: target }],
      operation: { tool: create ? "create_automation" : "delete_automation", access: "change", targets: [target] },
      ...((create || (stage === "after" && kind === "named")) ? { schedule: {
        title: lang === "ko" ? "아침 브리핑" : "Morning briefing", schedule_type: "interval",
        interval_seconds: 86400, start_at: "2099-01-01T07:00:00Z", access_mode: "full_access",
      } } : {}),
    };
  }, { stage });
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    for (const lang of ["ko", "en"]) for (const kind of ["named", "missing", "create"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&approval=1&state=completed&theme=${theme}&lang=${lang}&kind=${kind}`);
      const card = page.locator('[data-test-class="composer-authority-decision"]');
      await card.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const text = await card.innerText();
      if (stage === "after") {
        assert.ok(!text.includes("automation:"), text);
        assert.ok(!text.includes("internal-schedule-id"), text);
        assert.ok(text.includes(kind === "create" ? (lang === "ko" ? "예약 작업을 만들까요?" : "Create a schedule?")
          : lang === "ko" ? "예약 작업을 삭제할까요?" : "Delete a schedule?"), text);
        if (kind === "missing") {
          assert.ok(text.includes(lang === "ko" ? "예약 작업 정보를 확인할 수 없어요." : "Schedule details unavailable."), text);
        } else {
          assert.ok(text.includes(lang === "ko" ? "아침 브리핑" : "Morning briefing"), text);
          assert.ok(text.includes(lang === "ko" ? "실행 권한:" : "Run permission:"), text);
          assert.ok(text.includes(lang === "ko" ? "24시간마다 · 다음: 1월 1일 오전 7:00" : "Every 24 hours · Next: Jan 1, 7:00 AM"), text);
        }
      } else if (kind !== "create") {
        assert.ok(text.includes("automation:"), "baseline must reproduce the internal target");
      }
      await page.screenshot({ path: join(output, `${stage}-${kind}-${lang}-${theme}-${width}.png`) });
      checked++;
    }
  }
  assert.deepEqual(errors, [], "no uncaught renderer errors");
  console.log(JSON.stringify({ stage, checked, modelCalls: 0 }));
} finally { await browser.close(); server.stop(true); }
