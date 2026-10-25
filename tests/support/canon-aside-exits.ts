// test-category: race
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { canonAsideClose } from "./canon-board-aside.ts";

/** Every aside dismissal enters the same existing inline-edit guard. */
export async function verifyAsideCloseGuards(page: Page, server: NativeAppServerHandle, id: string) {
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  const card = page.locator('[data-kanban-item="' + id + '"]').getByRole("button").first();
  for (const exit of ["close", "escape", "selected-card"]) {
    for (const choice of ["계속 편집", "저장 안 함", "저장"]) {
      const before = await server.api<EpicDetail>("/canon/epics/" + id);
      const draft = before.title + " 검토";
      await detail.getByRole("button", { name: "제목 수정", exact: true }).click();
      const input = detail.getByLabel("제목", { exact: true });
      await input.fill(draft);
      if (exit === "close") await canonAsideClose(page).click();
      if (exit === "selected-card") await card.click();
      if (exit === "escape") {
        // Escape in the editor cancels only that field; a page Escape dismisses the aside.
        await canonAsideClose(page).evaluate(element => (element as HTMLElement).focus());
        await page.getByRole("alertdialog").getByRole("button", { name: "계속 편집", exact: true }).click();
        await page.getByRole("alertdialog").waitFor({ state: "hidden" });
        await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      }
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      const response = choice === "저장" ? page.waitForResponse(result =>
        result.request().method() === "PATCH" && new URL(result.url()).pathname === "/canon/epics/" + id) : null;
      await dialog.getByRole("button", { name: choice, exact: true }).click();
      if (response) assert((await response).ok());
      await dialog.waitFor({ state: "hidden" });
      if (choice === "계속 편집") {
        assert.equal(await input.inputValue(), draft);
        await input.press("Escape");
      } else {
        await page.locator('[data-slot="management-page-aside"]').waitFor({ state: "hidden" });
        assert.equal(await card.getAttribute("data-selected"), null);
        const after = await server.api<EpicDetail>("/canon/epics/" + id);
        assert.equal(after.title, choice === "저장" ? draft : before.title);
        await card.click(); await detail.getByRole("heading").first().waitFor();
      }
    }
  }
  // Restore the title so the existing shared field/exit flow checks retain their fixture contract.
  const current = await server.api<EpicDetail>("/canon/epics/" + id);
  await server.api("/canon/epics/" + id, { method: "PATCH", body: JSON.stringify({
    expected_revision: current.revision, title: "문서 화면 정리와 검색 개선안",
  }) });
  await detail.getByRole("heading", { name: "문서 화면 정리와 검색 개선안", exact: true }).waitFor();
}
