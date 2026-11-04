/** Real selection chips → composer send → persisted image tiles and model refusal. */
import { strict as assert } from "node:assert";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { waitBrowser } from "./browser-agent-app";
import type { redesignApp } from "./browser-redesign-app";
import { shellReady } from "./browser-shell-acceptance";

type App = Awaited<ReturnType<typeof redesignApp>>;
const CHIPS = '[data-slot="element-chip"]';
const SENT = 'article [data-test-class="message-attachment-list"]';
export async function sendBrowserCaptures(app: App, tab: string) {
  await app.click(getAppCopy("en-US").space.general);
  await waitBrowser(() => app.page.expression(`document.querySelectorAll('${CHIPS}').length===2&&Array.from(document.querySelectorAll('${CHIPS} img')).every(i=>i.complete&&i.naturalWidth>0)`), "capture chips ready");
  for (const theme of ["light", "dark"]) {
    await app.settings("en", theme, 1440);
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${CHIPS}').length===2&&Array.from(document.querySelectorAll('${CHIPS} img')).every(i=>i.complete&&i.naturalWidth>0)`), "capture chips ready");
    await app.shot(`selection-composer-${theme}`);
  }
  const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
  await app.page.clickSelector('[contenteditable="true"]');
  await app.page.insertText("Describe the selection");
  await app.click("Send");
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general")).latest_turn?.id !== prior.latest_turn?.id, "capture turn admitted");
  await app.delivered();
  await waitBrowser(() => app.page.expression(`document.querySelectorAll('${CHIPS}').length===0`), "submitted chips cleared");
  const view = await app.gateway.api<any>("/session-view?session_id=general");
  const user = [...view.messages].reverse().find((m: any) => m.role === "user");
  assert.equal(user.attachments.length, 2);
  assert.ok(user.attachments.every((file: any) => file.kind === "image"));
  assert.deepEqual(Object.keys(user.content_parts.attachment_metadata).sort(), user.attachments.map((file: any) => file.file_id).sort());
  await waitBrowser(() => app.page.expression(`(()=>{const list=[...document.querySelectorAll('${SENT}')].at(-1);const tiles=[...(list?.querySelectorAll('[data-slot="attachment-tile"]')??[])];return tiles.length===2&&tiles.every(tile=>tile.querySelector('img')?.naturalWidth>0)})()`), "sent capture tiles");
  assert.ok(await app.page.expression<boolean>(`(()=>{const list=[...document.querySelectorAll('${SENT}')].at(-1);return [...list.querySelectorAll('[data-slot="attachment-tile"] img')].every(img=>getComputedStyle(img).objectFit==='contain')})()`));
  for (const theme of ["light", "dark"]) {
    await app.settings("en", theme, 1440);
    await app.shot(`selection-sent-${theme}`);
  }
  const settings = await app.gateway.api<{ model: string }>("/settings");
  const registered = await app.gateway.api<any>("/model-catalog/local-models", { method: "POST", body: JSON.stringify({
    provider_id: "local", api_type: "openai_compatible", platform: "custom", server_url: app.gateway.url,
    model_id: "text-only", display_name: "Text only", context_window_tokens: 128000, source: "manual", image_input: false,
  }) });
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ model: registered.model.model_ref }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.call("selection-command", { id: tab, op: "attach" });
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-test-class=composer-card] [data-blocked=true]').length===2"), "text-only model marks both images blocked");
  assert.ok(await app.page.expression<boolean>("[...document.querySelectorAll('[data-test-class=composer-card] [data-blocked=true]')].every(item=>item.querySelector('img')?.getAttribute('data-fit')==='contain')"));
  await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=composer-send-button]')?.getAttribute('aria-disabled')==='true'"), "send blocked for the text-only model");
  for (const theme of ["light", "dark"]) {
    await app.settings("en", theme, 1440);
    await app.shot(`selection-refused-${theme}`);
  }
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ model: settings.model }) });
  await app.page.reload(); await shellReady(app, "en");
}
