// Real isolated command hook -> gateway rejection -> retained composer text.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
const data = mkdtempSync(join(tmpdir(), "hook-prompt-"));
writeFileSync(join(data, "hooks.json"), JSON.stringify({ version: 1, hooks: [{ id: "guard", event: "UserPromptSubmit", type: "command", args: ["sh", "-c", "printf '{\"decision\":\"deny\",\"reason\":\"Keep the draft\"}'"] }] }));
const server = await createNativeAppServer({ butlerData: data, uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const output = process.env.HOOK_PROMPT_SCREENSHOTS ?? join(tmpdir(), "butler-hooks-prompt");
mkdirSync(output, { recursive: true });
try {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const language of ["en", "ko"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, language }) });
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    await server.signIn(page);
    await page.goto(server.url);
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill("Exact retained draft 한글");
    await page.screenshot({ path: join(output, `before-${width}-${theme}-${language}.png`) });
    await editor.press("Control+Enter");
    await page.getByText(/Keep the draft/u).first().waitFor();
    assert.equal(await editor.innerText(), "Exact retained draft 한글");
    assert.equal(server.stubModelCalls.length, 0, "rejection never reaches the model");
    await page.screenshot({ path: join(output, `after-${width}-${theme}-${language}.png`) });
    await page.close();
  }
  console.log("Prompt deny: 8 viewport/theme/language cases retained exact text; zero model calls");
} finally { await browser.close(); await server.stop(); rmSync(data, { recursive: true, force: true }); }
