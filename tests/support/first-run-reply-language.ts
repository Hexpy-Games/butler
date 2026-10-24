import { strict as assert } from "node:assert";
import { evaluateBoolean, evaluateString, waitForExpression, type CdpClient } from "./first-run-cdp";

const enabledReply = "document.querySelector('#first-run-reply-language')?.disabled === false";
const workspace = "!document.querySelector('[data-test-class=first-run-setup]') && Boolean(document.querySelector('[data-test-class=workspace]'))";

export async function chooseReplyLanguage(client: CdpClient): Promise<string> {
  const initial = JSON.parse(await evaluateString(client, "window.butlerApp.getPersonalization().then(JSON.stringify)"));
  assert.equal(await evaluateString(client, "document.querySelector('#first-run-reply-language')?.value"), initial.response_language, "backend default preselected");
  assert.equal(initial.response_language_explicit, false, "derived default is not explicit");
  await reloadInto(client, enabledReply, "reply choice resumes without reconnecting");
  assert.equal(await evaluateString(client, "document.querySelector('#first-run-reply-language')?.value"), initial.response_language);
  const chosen = initial.response_language === "ko" ? "en" : "ko";
  assert(await evaluateBoolean(client, `(() => {
    const select = document.querySelector('#first-run-reply-language');
    select.value = ${JSON.stringify(chosen)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(chosen)};
  })()`), "nondefault reply language selected");
  const original = JSON.parse(await evaluateString(client, "JSON.stringify({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, mobile: false })"));
  try {
    for (const width of [320, 375, 390, 430, 768, 1280]) {
      await client.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert(await evaluateBoolean(client, "document.documentElement.scrollWidth <= innerWidth"), `reply step overflow at ${width}`);
    }
  } finally {
    await client.send("Emulation.setDeviceMetricsOverride", original);
  }
  return chosen;
}

export async function verifyReplyLanguageSaved(client: CdpClient, chosen: string): Promise<void> {
  await waitForExpression(client, "Boolean(document.querySelector('[contenteditable=true]'))", "first chat editor");
  const read = () => evaluateString(client, "window.butlerApp.getPersonalization().then(JSON.stringify)").then(JSON.parse);
  const saved = await read();
  assert.equal(saved.response_language, chosen, "reply choice persisted through the gateway personalization API");
  assert.equal(saved.response_language_explicit, true, "reply choice persisted explicitly");
  for (const language of ["en", "ko"]) {
    assert(await evaluateBoolean(client, `window.butlerApp.updateSettings({ language: ${JSON.stringify(language)} }).then(result => result.ok !== false)`), "interface language saved");
  }
  assert.equal((await read()).response_language, chosen, "interface language preserves reply choice");
  await reloadInto(client, workspace, "workspace after reload");
  assert(await evaluateBoolean(client, "document.querySelector('#first-run-reply-language') === null"), "reply choice is not asked again");
  assert.equal((await read()).response_language, chosen, "reply choice survives reload");
}

async function reloadInto(client: CdpClient, state: string, label: string): Promise<void> {
  const origin = await evaluateString(client, "String(performance.timeOrigin)");
  await client.send("Page.reload");
  await waitForExpression(client, `String(performance.timeOrigin) !== ${JSON.stringify(origin)} && (${state})`, label);
}
