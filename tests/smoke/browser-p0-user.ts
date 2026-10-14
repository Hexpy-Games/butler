/** Real P2a-1 Browser area: renderer IPC owns create/navigation/close. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { waitFor } from "./browser-p0-app";
import type { P0App } from "./browser-p0-measure";

export async function openBrowserArea(app: P0App) {
  await app.page.waitForFunction(() => Array.from(document.querySelectorAll("button,[role=button]"))
    .some(e => (e.getAttribute("aria-label") || e.textContent)?.trim() === "브라우저"));
  await app.page.clickText("브라우저", "button,[role=button]");
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-area"]')));
}

export async function visitUserSite(app: P0App, url: string, evidence?: string) {
  const id = await app.page.expression<string>(`window.butlerBrowser.call('create',${JSON.stringify({ url })})`);
  try {
    await waitFor(() => app.page.expression(`window.butlerBrowser.call('state').then(s=>s.tabs.some(t=>t.id===${JSON.stringify(id)}&&t.status==='idle'&&t.url===${JSON.stringify(url)}))`), "public USER navigation complete");
    await waitFor(() => app.main.evaluate(`browserP0.productView(${JSON.stringify(id)}).attached`), "USER native view attached");
    const load1 = loadavg()[0];
    const result = await app.main.evaluate<{ jpegBytes: number }>(`browserP0.productStep(${JSON.stringify(id)})`);
    assert(result.jpegBytes > 0, "Complete USER observe/act/capture");
    const still = await app.page.expression<string>(`window.butlerBrowser.call('still',{id:${JSON.stringify(id)}})`);
    assert(still.startsWith("data:image/jpeg;base64,"), "Product capturePage still retained");
    if (evidence) {
      writeFileSync(join(evidence, "real-browser-area.png"), await app.page.screenshot());
      writeFileSync(join(evidence, "real-browser-native.jpg"), Buffer.from(still.split(",")[1]!, "base64"));
    }
    return { id, ...result, stillBytes: still.length, load1 };
  } finally {
    await app.page.expression(`window.butlerBrowser.call('close',{id:${JSON.stringify(id)}})`);
    await waitFor(() => app.page.expression(`window.butlerBrowser.call('state').then(s=>!s.tabs.some(t=>t.id===${JSON.stringify(id)}))`), "USER tab removed");
    await app.page.expression("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    assert.equal((await app.main.evaluate<{ count: number }>("browserP0.productErrors()")).count, 0, "No rejected product IPC during tab lifecycle");
  }
}
