// Public Settings flow over the real gateway; no model calls.
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import type { AppCopy } from "../../packages/butler-i18n/src/copy-contract";
import type { NativeAppServerHandle } from "./native-app-server";

export async function commandSandboxSettings(page: Page, server: NativeAppServerHandle, copy: AppCopy) {
  await page.goto(`${server.url}?settings=general`, { waitUntil: "domcontentloaded" });
  const toggle = page.getByRole("switch", { name: copy.settings.fields.commandSandbox, exact: true });
  await toggle.waitFor();
  const settings = await server.api<{ command_sandbox_available: boolean; command_sandbox_enabled: boolean }>("/settings");
  assert.equal(await toggle.isDisabled(), !settings.command_sandbox_available);
  if (settings.command_sandbox_available) {
    for (const enabled of [false, true]) {
      if (await toggle.isChecked() !== enabled) {
        const response = page.waitForResponse(response => response.url().endsWith("/settings") && response.request().method() === "PATCH");
        await toggle.click();
        assert.equal((await response).status(), 200);
      }
      const stored = await server.api<{ command_sandbox_enabled: boolean }>("/settings");
      assert.equal(stored.command_sandbox_enabled, enabled);
      await page.reload({ waitUntil: "domcontentloaded" });
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), enabled, "sandbox setting survives reload");
      assert.equal(await toggle.isEnabled(), true, "turning off does not disable the control");
    }
  }
  // Transport fixture for a host without project-write containment.
  const unavailable = await server.api<Record<string, unknown>>("/settings");
  await page.route(`${server.url}settings`, route => route.fulfill({
    json: { protocol_version: "butler.app.v1", data: { ...unavailable, command_sandbox_available: false } },
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  assert.equal(await toggle.isDisabled(), true);
  assert.equal(await toggle.isChecked(), false, "unavailable containment never displays as enabled");
  await toggle.hover();
  const tooltip = page.getByRole("tooltip", { name: copy.settings.descriptions.commandSandboxUnavailable, exact: true });
  await tooltip.waitFor();
  await tooltip.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  // The reason opens beside the switch: it covers neither the label nor the description and stays on screen.
  const field = page.locator('[data-setting-id="command-sandbox"]');
  const [tip, label, description] = await Promise.all([
    tooltip.boundingBox(),
    field.locator("label").first().boundingBox(),
    field.getByText(copy.settings.descriptions.commandSandbox, { exact: true }).boundingBox(),
  ]);
  assert(tip && label && description, "tooltip, label and description are laid out");
  const overlaps = (a: typeof tip, b: typeof tip) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  assert(!overlaps(tip, label), `sandbox reason covers the label: ${JSON.stringify({ tip, label })}`);
  assert(!overlaps(tip, description), `sandbox reason covers the description: ${JSON.stringify({ tip, description })}`);
  const viewport = page.viewportSize()!;
  assert(tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= viewport.width && tip.y + tip.height <= viewport.height,
    `sandbox reason stays on screen: ${JSON.stringify({ tip, viewport })}`);
  await page.unroute(`${server.url}settings`);
  await page.goto(server.url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-test-class~="composer-card"]').waitFor();
}
