import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Browser } from "playwright";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { auditSessionInfoFocus, installSessionBrowser, replaySession, sessionWorkerSubtasks } from "./session-info-fixtures.ts";

export async function verifySessionInfoWorkers(browser: Browser, server: NativeAppServerHandle, original: SessionView, shots: string, theme: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
  let view = { ...original, subtasks: sessionWorkerSubtasks() };
  try {
    await installSessionBrowser(page);
    await replaySession(page, () => view, () => false);
    await page.route("**/session-view?**", async route => {
      const worker = view.subtasks.flatMap(task => task.workers ?? []).find(worker => worker.session_id === new URL(route.request().url()).searchParams.get("session_id"));
      if (!worker) return route.fallback();
      return route.fulfill({ json: { protocol_version: "butler.app.v1", data: { ...original, session_id: worker.session_id,
        parent_session_id: original.session_id, messages: [{ id: "worker-report", chat_id: worker.session_id, role: "assistant", text: "API 변경 검토를 진행합니다.", created_at: original.updated_at }] } } });
    });
    await page.addInitScript(id => {
      if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", active_session_id: id, left_open: true, right_open: false }));
    }, original.session_id);
    await server.signIn(page);
    await page.goto(server.url);
    await page.locator('[data-test-class="session-info-toggle"]').click();
    const section = page.locator('[data-session-section="subtasks"]');
    const workers = section.locator('[data-test-class="subtask-worker-row"]');
    await workers.first().waitFor();
    assert.deepEqual(await workers.allTextContents(), ["API 변경 확인작업 중", "문구 검토완료", "빌드 결과 확인실패"]);
    assert.equal(await section.getByRole("group", { name: "변경 사항 검토", exact: true }).count(), 1);
    const boxes = await section.locator('[data-test-class="subtask-row"], [data-test-class="subtask-worker-row"]').evaluateAll(nodes => nodes.map(node => ({ y: node.getBoundingClientRect().y, bottom: node.getBoundingClientRect().bottom })));
    const workerGap = boxes[4]!.y - boxes[3]!.bottom;
    const focus = await auditSessionInfoFocus(page, section);
    assert.deepEqual(focus.clips, []);
    const read = page.waitForResponse(response => response.url().includes("session_id=review-api"));
    await workers.first().click();
    await read;
    const observer = page.locator('[data-test-class="steward-observer-dialog"]');
    await observer.getByText("API 변경 검토를 진행합니다.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await observer.waitFor({ state: "hidden" });
    await page.screenshot({ path: join(shots, `si-workers-${theme}.png`), animations: "disabled" });
    view = { ...view, subtasks: view.subtasks.map(task => ({ ...task, workers: undefined })) };
    await page.reload();
    await section.locator('[data-test-class="subtask-row"]').first().waitFor();
    const plain = await section.locator('[data-test-class="subtask-row"]').evaluateAll(nodes => nodes.map(node => ({ y: node.getBoundingClientRect().y, bottom: node.getBoundingClientRect().bottom })));
    const plainGap = plain[1]!.y - plain[0]!.bottom;
    assert.equal(workerGap, plainGap);
    console.log(JSON.stringify({ sessionWorkers: { workerGap, plainGap, focusStops: focus.stops, observer: "review-api" } }));
  } finally { await page.close(); }
}
