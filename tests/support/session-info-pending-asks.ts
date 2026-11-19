import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import type { Browser } from "playwright";
import type { NativeAppServerHandle, NativeAppServerOptions } from "./native-app-server.ts";
import type { SessionPendingAsks } from "../../packages/butler-app/client/shared/pending-asks-contracts.ts";

/** The pending-asks proof deliberately has no HTTP or event replay. */
export function sessionInfoStub(): NativeAppServerOptions {
  let offered = false;
  return {
    stubReply: request => request.stream ? "검토 범위를 확인하겠습니다." : "{}",
    stubToolCall: request => {
      if (offered || !request.stream || !Array.isArray(request.body.tools) || !request.body.tools.length
        || !JSON.stringify(request.messages).includes("릴리스 노트 검토 범위를 확인해 주세요.")) return null;
      offered = true;
      return { name: "ask_user", arguments: { questions: [{ id: "scope", eyebrow: "검토 범위", title: "어떤 범위를 검토할까요?",
        kind: "single", allow_custom: false, options: [{ id: "changes", label: "변경 사항" }, { id: "all", label: "전체" }] }] } };
    },
  };
}

export async function verifyNativePendingAsks(browser: Browser, server: NativeAppServerHandle, theme: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
  try {
    const { session } = await server.api<{ session: { id: string } }>("/sessions", {
      method: "POST", body: JSON.stringify({ kind: "chat", title: "릴리스 검토 범위" }),
    });
    const sessionId = session.id;
    await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false,
    })), sessionId);
    await server.signIn(page);
    await page.goto(server.url);
    await page.locator('[data-slot="composer-compact-preview"]').click();
    await page.locator('[contenteditable="true"]').fill("릴리스 노트 검토 범위를 확인해 주세요.");
    await page.getByRole("button", { name: "전송", exact: true }).click();
    const question = page.locator('[data-slot="composer-question-panel"]');
    await question.getByText("어떤 범위를 검토할까요?", { exact: true }).waitFor();
    const toggle = page.locator('[data-test-class="session-info-toggle"]');
    await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="session-info-toggle"] [data-slot="icon-button-indicator"]')));
    await toggle.click();
    const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
    await aside.locator('[data-session-section="asks"]').getByText("어떤 범위를 검토할까요?", { exact: true }).waitFor();
    const pending = await server.api<SessionPendingAsks>(`/sessions/${sessionId}/pending-asks`);
    assert.equal(pending.open_count, 1);
    assert.equal(pending.asks[0]?.kind, "question");
    if (pending.asks[0]?.source_message_id) {
      await aside.getByText("어떤 범위를 검토할까요?", { exact: true }).click();
      // P1 may replace its user-message fallback once the assistant message is
      // persisted. The row navigates the projection it rendered, not this later GET.
      await page.locator("[data-request-source-message]").filter({ hasText: "어떤 범위를 검토할까요?" }).waitFor({ state: "visible" });
    }
    await question.getByText("변경 사항", { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-test-class="session-info-toggle"] [data-slot="icon-button-indicator"]'));
    assert.equal(await aside.locator('[data-session-section="asks"]').count(), 0);
    assert.equal((await server.api<SessionPendingAsks>(`/sessions/${sessionId}/pending-asks`)).open_count, 0);
    console.log(JSON.stringify({ nativePendingAsks: "PASS", theme, open: 1, answered: 0, realRoutesAndEvents: true }));
  } catch (error) {
    console.error("NATIVE_PENDING_FAILURE", await page.locator("body").innerText());
    console.error("STUB_CALL_SHAPES", JSON.stringify(server.stubModelCalls.map(call => ({ stream: call.stream,
      tools: Array.isArray(call.body.tools) ? call.body.tools.length : 0,
      hasRequest: JSON.stringify(call.messages).includes("릴리스 노트 검토 범위를 확인해 주세요.") }))));
    throw error;
  } finally {
    await page.close();
  }
}

/** Rename only the isolated Custom model through the normal catalog mutation. */
export async function labelSessionInfoModel(server: NativeAppServerHandle) {
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  await server.api("/model-catalog/local-models/local%2Fstub", { method: "PATCH", body: JSON.stringify({
    provider_id: "local", api_type: "openai_compatible", platform: "custom", model_id: "stub",
    server_url: config.models.local[0].server_url, context_window_tokens: 128000, display_name: "로컬 모델",
  }) });
}
