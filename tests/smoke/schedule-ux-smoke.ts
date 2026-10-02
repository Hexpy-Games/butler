import { launchSmokeBrowser } from "../support/browser-launch.ts";
// Public UI -> gateway smoke; native login calls use an isolated bridge stub.
import { readFileSync } from "node:fs";
import { type Page } from "playwright";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function choose(page: Page, label: string, option: string) {
  await page.getByText(label, { exact: true }).locator("..").getByRole("combobox").click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: "en" } } });
const browser = await launchSmokeBrowser();
try {
  const context = await browser.newContext({ timezoneId: "Asia/Seoul", viewport: { width: 1440, height: 900 } });
  await server.signIn(context);
  const page = await context.newPage();
  await page.addInitScript(({ code, url }) => {
    let openAtLogin = false;
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, value: unknown) => Reflect.set(window, name, value) },
      ipcRenderer: {
        on: () => {}, removeListener: () => {},
        invoke: async (channel: string, input?: { openAtLogin: boolean }) => {
          if (channel === "butler:get-server-url") return url;
          if (channel === "butler:get-local-auth-headers") return {};
          if (channel === "butler:get-login-settings") return { openAtLogin };
          if (channel === "butler:set-login-settings") { openAtLogin = input!.openAtLogin; return { openAtLogin }; }
          return {};
        },
      },
    };
    new Function("require", "process", code)(() => electron, { env: { BUTLER_APP_SERVER_URL: url }, argv: [], platform: "darwin" });
  }, { code: readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8"), url: server.url });
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.goto(server.url);
  await page.locator('[data-test-class~="app-sidebar"]').waitFor();
  await page.getByRole("button", { name: "Space menu", exact: true }).click();
  await page.getByText("Schedules", { exact: true }).first().click();
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page.getByPlaceholder("Schedule title").fill("Daily eight");
  await page.getByPlaceholder("Prompt body").fill("Summarize the day");
  await choose(page, "Frequency", "Daily");
  await page.locator('input[type="time"]').fill("08:00");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Start at login for your schedules. Settings → General.", { exact: true }).waitFor();
  const data = await server.api<{ automations: Array<{ title: string; schedule: { kind: string; time: string; tz: string } }> }>("/automations");
  assert(data.automations.length === 1, "one complete schedule was saved");
  assert(JSON.stringify(data.automations[0]?.schedule) === JSON.stringify({ kind: "daily", time: "08:00", weekdays: [], tz: "Asia/Seoul" }), `form saved local 08:00 recurrence: ${JSON.stringify(data.automations[0]?.schedule)}`);
  await page.getByRole("button", { name: "Back to schedules", exact: true }).click();
  await page.getByText(/On · Every day at 8:00 AM · Next:/u).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const login = page.getByRole("switch", { name: "Start at login", exact: true });
  await login.check();
  assert(await login.isChecked(), "General settings toggled native login state");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  await page.reload();
  await page.getByRole("button", { name: "스페이스 메뉴", exact: true }).click();
  await page.getByText("예약 작업", { exact: true }).first().click();
  await page.getByText(/켜짐 · 매일 오전 8:00 · 다음:/u).waitFor();
  assert(await page.getByText("예약 작업을 위해 로그인 시 시작을 켜세요. 설정 → 일반.", { exact: true }).count() === 0, "login hint was not repeated");
  console.log("Schedule UI smoke passed: local-time payload, localized list and one-time login hint");
} finally {
  await browser.close();
  await server.stop();
}
