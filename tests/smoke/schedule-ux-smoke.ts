import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Public UI -> gateway smoke; native login calls use an isolated bridge stub.
import { readFileSync } from "node:fs";
import { type Page } from "playwright";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { registerSecondModel } from "../support/second-stub-model.ts";

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
  await registerSecondModel(server);
  const catalog = await server.api<{ registered_models: Array<{ model_id: string; model_ref: string }> }>("/model-catalog");
  const stubB = catalog.registered_models.find((model) => model.model_id === "stub-b")?.model_ref;
  assert(stubB, "the second stub model is registered");
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
  await page.getByText("Schedules", { exact: true }).first().click();
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page.getByPlaceholder("Schedule title").fill("Daily eight");
  await page.getByPlaceholder("Prompt body").fill("Summarize the day");
  await choose(page, "Frequency", "Daily");
  await page.locator('input[type="time"]').fill("08:00");
  const modelTrigger = page.locator('[data-test-class="automation-model-trigger"]');
  assert(await modelTrigger.locator('[data-slot="select-value-label"]').innerText() === "Model default", "an unset model shows its default label");
  await modelTrigger.click();
  const modelList = page.getByRole("listbox");
  assert(await modelList.getByRole("option").first().innerText() === "Model default\nFollows the target chat's model.", "the first model option is the described default");
  assert(await modelList.locator('h1, h2, h3, h4, h5, h6, [role="heading"], [data-slot="select-label"], input, [role="searchbox"], [role="tablist"]').count() === 0, "the model list has no inner heading, search or provider tabs");
  const inheritedLabel = await modelList.getByRole("option").nth(1).innerText();
  await modelList.getByRole("option", { name: /Stub B/u }).click();
  await modelTrigger.getByText(/Stub B/u).waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Start at login for your schedules. Settings → General.", { exact: true }).waitFor();
  const data = await server.api<{ automations: Array<{ id: string; title: string; model?: string | null; schedule: { kind: string; time: string; tz: string } }> }>("/automations");
  assert(data.automations.length === 1, "one complete schedule was saved");
  assert(data.automations[0]?.model === stubB, `form saved the chosen model: ${data.automations[0]?.model}`);
  assert(JSON.stringify(data.automations[0]?.schedule) === JSON.stringify({ kind: "daily", time: "08:00", weekdays: [], tz: "Asia/Seoul" }), `form saved local 08:00 recurrence: ${JSON.stringify(data.automations[0]?.schedule)}`);
  await page.getByRole("button", { name: "Back to schedules", exact: true }).click();
  await page.getByText("Daily eight", { exact: true }).click();
  await modelTrigger.getByText(/Stub B/u).waitFor();
  await modelTrigger.click();
  await page.getByRole("option", { name: "Model default Follows the target chat's model.", exact: true }).click();
  assert(await modelTrigger.locator('[data-slot="select-value-label"]').innerText() === "Model default", "an explicit model can return to default");
  const cleared = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/automations/"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const clearResponse = await cleared;
  assert(clearResponse.request().postDataJSON().model === "", "save sends the cleared override");
  assert(clearResponse.ok(), "clearing the model succeeds");
  await page.getByRole("button", { name: "Back to schedules", exact: true }).click();
  await page.getByText("Daily eight", { exact: true }).click();
  await modelTrigger.getByText("Model default", { exact: true }).waitFor();
  const unchanged = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/automations/"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert(!Object.hasOwn((await unchanged).request().postDataJSON(), "model"), "an unchanged default omits the model");
  await page.getByRole("button", { name: "Back to schedules", exact: true }).click();
  await page.getByText(/On · Every day at 8:00 AM · Next:/u).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const title = page.getByText("Daily eight", { exact: true });
  const row = title.locator("../../..");
  const meta = row.getByText(/On · Every day at 8:00 AM · Next:/u);
  const titleBox = await title.boundingBox();
  const rowBox = await row.boundingBox();
  const metaBox = await meta.boundingBox();
  assert(titleBox && titleBox.width > 0, `390px schedule title has positive width: ${JSON.stringify(titleBox)}`);
  assert(rowBox && titleBox.x >= rowBox.x && titleBox.x + titleBox.width <= rowBox.x + rowBox.width, "390px schedule title stays inside the row horizontally");
  assert(metaBox && rowBox && metaBox.x >= rowBox.x && metaBox.x + metaBox.width <= rowBox.x + rowBox.width, "390px schedule meta stays inside the row horizontally");
  await page.setViewportSize({ width: 1440, height: 900 });
  const scheduleId = data.automations[0]!.id;
  await server.api(`/automations/${scheduleId}`, { method: "PATCH", body: JSON.stringify({ model: stubB }) });
  await server.api(`/model-catalog/local-models/${encodeURIComponent(stubB)}`, { method: "DELETE" });
  await page.reload();
  await page.getByText("Schedules", { exact: true }).first().click();
  await page.getByText("Daily eight", { exact: true }).click();
  await modelTrigger.getByText(inheritedLabel, { exact: true }).waitFor();
  const unavailableUnchanged = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/automations/"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert(!Object.hasOwn((await unavailableUnchanged).request().postDataJSON(), "model"), "showing the fallback preserves an unavailable override");
  const unavailableSaved = await server.api<{ automation: { model: string } }>(`/automations/${scheduleId}`);
  assert(unavailableSaved.automation.model === stubB, "saving an unchanged unavailable override keeps it");
  await modelTrigger.click();
  await page.getByRole("option", { name: "Model default Follows the target chat's model.", exact: true }).click();
  const unavailableCleared = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/automations/"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert((await unavailableCleared).request().postDataJSON().model === "", "default clears an unavailable override");
  await page.getByRole("button", { name: "Back to schedules", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const login = page.getByRole("switch", { name: "Start at login", exact: true });
  await login.check();
  assert(await login.isChecked(), "General settings toggled native login state");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  await page.reload();
  await page.getByText("예약 작업", { exact: true }).first().click();
  await page.getByText(/켜짐 · 매일 오전 8:00 · 다음:/u).waitFor();
  assert(await page.getByText("예약 작업을 위해 로그인 시 시작을 켜세요. 설정 → 일반.", { exact: true }).count() === 0, "login hint was not repeated");
  console.log("Schedule UI smoke passed: local-time payload, chosen and cleared model, unchanged-model payload, unavailable-model fallback, localized list and one-time login hint");
} finally {
  await browser.close();
  await server.stop();
}
