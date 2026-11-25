import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Page } from "playwright";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { computerFixtures, type createComputersFake } from "./computers-fixtures.ts";

export type ComputerChange = {
  id: number;
  type: "computers.changed";
  created_at: string;
  payload: { computer_id: string; sign_in: boolean };
};

export async function checkComputerSignInEvent(page: Page, { fake, serve }: {
  fake: ReturnType<typeof createComputersFake>;
  serve(events: Promise<ComputerChange>[]): Promise<void>;
}) {
  const computer = { ...computerFixtures[0]!, model_source: "chatgpt" as const, ai_connected: false };
  fake.computers = [computer];
  const dialog = page.locator('[data-test-class="computer-ai-dialog"]');
  const security = page.locator('[data-settings-section-id="computers"]');
  const chat = page.locator('[data-slot="composer-compact-preview"]');
  const startPath = `/computers/${computer.id}/oauth/start`;
  const calls = (path: string, method: string) => fake.calls.filter(call => call.path === path && call.method === method).length;
  function eventDelivery(id: number) {
    const { promise, resolve } = Promise.withResolvers<ComputerChange>();
    return { promise, deliver: (sign_in: boolean, age = 0) => resolve({
      id, type: "computers.changed", created_at: new Date(Date.now() - age).toISOString(),
      payload: { computer_id: computer.id, sign_in },
    }) };
  }
  const recent = eventDelivery(900_000);
  const refresh = eventDelivery(900_001);
  const old = eventDelivery(900_002);
  const refused = eventDelivery(900_003);
  await serve([recent.promise, refresh.promise, old.promise, refused.promise]);
  await chat.waitFor();

  const starts = calls(startPath, "POST");
  recent.deliver(true);
  await dialog.getByText(appCopy.computers.model.description(computer.name), { exact: true }).waitFor();
  await security.waitFor();
  const continueButton = dialog.getByRole("button", { name: appCopy.chatgptPlan.continue, exact: true });
  await continueButton.waitFor();
  assert.equal(calls(startPath, "POST"), starts);
  await captureSignIn(page);

  const started = page.waitForResponse(response => new URL(response.url()).pathname === startPath);
  await continueButton.click();
  assert.equal((await started).status(), 200);
  await dialog.getByText(appCopy.chatgptSignIn.pending, { exact: true }).waitFor();
  const cancel = dialog.getByRole("button", { name: appCopy.common.cancel, exact: true });
  await cancel.click();
  await continueButton.waitFor();
  await cancel.click();
  await dialog.waitFor({ state: "hidden" });

  const lists = calls("/computers", "GET");
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/computers");
  refresh.deliver(false);
  await refreshed;
  assert(calls("/computers", "GET") > lists);
  assert.equal(await dialog.count(), 0);
  await page.keyboard.press("Escape");
  await chat.waitFor();

  const afterOld = page.waitForRequest(request => new URL(request.url()).searchParams.get("cursor") === "900002");
  old.deliver(true, 10 * 60_000);
  await afterOld;
  assert(await chat.isVisible());
  assert.equal(await dialog.count(), 0);

  await page.route("**/computers", route => route.request().method() === "GET"
    ? route.fulfill({ status: 403, json: { error: { code: "loopback_required", message: "TEST" } } })
    : route.fallback());
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/computers" && response.status() === 403);
  const exhausted = page.waitForResponse(response => new URL(response.url()).pathname === "/events/live" && response.status() === 204);
  refused.deliver(true);
  await denied;
  await exhausted;
  assert(await chat.isVisible());
  assert.equal(await dialog.count(), 0);
}

async function captureSignIn(page: Page) {
  const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
  if (!output) return;
  const language = process.env.COMPUTERS_SMOKE_LANGUAGE ?? "ko";
  for (const [theme, width] of language === "ko"
    ? [["light", 1280], ["dark", 1280], ["light", 375], ["dark", 375]] as const
    : [["light", 1280]] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 1000 });
    await page.locator(`body.theme-${theme}`).waitFor();
    await page.screenshot({ path: join(output, `5-${language}-${theme}-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}
