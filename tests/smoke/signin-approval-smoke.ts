// Browser behavior smoke: the real approval renderer and KO/EN copy, offline.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const stage = process.env.BUTLER_SIGNIN_APPROVAL_STAGE ?? "after";
const output = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(output, "BUTLER_BROWSER_EVIDENCE required");
mkdirSync(output, { recursive: true });
const root = resolve(process.env.BUTLER_SMOKE_RENDERER_DIST ?? "packages/butler-app/client/ui/dist");
const native = process.env.BUTLER_SIGNIN_APPROVAL_NATIVE === "1" ? await createNativeAppServer({ uiRoot: root }) : undefined;
const server = native ? undefined : Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await launchSmokeBrowser();
const labels = {
  ko: ["2단계 인증", "패스키", "보안 문자", "보안 키패드", "로그인 양식 확인"],
  en: ["Two-step verification", "Passkey", "CAPTCHA", "Security keypad", "Check sign-in form"],
};
const reasons = ["mfa", "passkey", "captcha", "secure_keypad", "unknown_form"];
let checked = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  if (native) await native.signIn(page.context());
  await page.addInitScript(() => {
    const params = new URLSearchParams(window.location.search);
    const stage = params.get("stage");
    const reason = params.get("reason");
    (window as Window & { butlerApprovalFixture?: unknown }).butlerApprovalFixture = {
      action_kind: "other", count: 1, risk: "low", targets: [], examples: [],
      operation: { tool: "browser_sign_in_wait", access: "read_only", allow_conversation: false,
        targets: stage === "before" ? ["private-tab-id", reason] : ["example.test"],
        ...(stage === "before" ? {} : { sign_in_step: reason }) },
    };
  });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    for (const lang of ["ko", "en"] as const) for (const [index, reason] of reasons.entries()) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${native?.url ?? `http://127.0.0.1:${server!.port}/`}?visual=components&surface=activity-layout&approval=1&state=completed&theme=${theme}&lang=${lang}&stage=${stage}&reason=${reason}`);
      if (stage === "after") {
        await page.getByText(labels[lang][index], { exact: true }).waitFor();
        await page.getByText("example.test", { exact: true }).waitFor();
        const text = await page.locator("body").innerText();
        assert.ok(!text.includes("private-tab-id"), "tab ids stay out of the card");
        assert.ok(!text.includes(reason), "raw sign-in codes stay out of the card");
      } else await page.getByText("private-tab-id", { exact: true }).waitFor();
      if (index === 0) await page.screenshot({ path: join(output, `${stage}-${lang}-${theme}-${width}.png`) });
      checked++;
    }
  }
  console.log(JSON.stringify({ stage, checked, modelCalls: 0 }));
} finally { await browser.close(); server?.stop(true); await native?.stop(); }
