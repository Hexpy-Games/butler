// Real App screenshots with deterministic Memory route fixtures. No model calls.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { auditMemoryDesign } from "../support/memory-page-audit.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import { checkProfileInstructionSeparation, checkMemoryRefreshDuringRead } from "../support/memory-profile-acceptance.ts";

const output = process.env.BUTLER_MEMORY_SHOTS ?? resolve(".tmp/memory-shots");
mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await chromium.launch({ headless: true });
const report: Array<{ file: string; result: string; audit: unknown }> = [];
const operationId = "00000000-0000-4000-8000-000000000777";
const now = new Date().toISOString();
const themes = ["light", "dark"] as const;
const locales = ["ko", "en"] as const;
const states = ["populated", "long", "confirm", "confirm-long", "deleting", "empty", "load-failure", "loading", "not-measured", "unavailable", "no-projects", "delete-failed", "deleted", "nothing-to-free", "cleanup-waiting", "cleanup-running", "cleanup-done", "cleanup-stopped", "cleanup-cancelled", "personalization", "system-events", ...["chat", "profile", "project"].flatMap(kind => ["confirm", "running", "done", "failed"].map(state => `reset-${kind}-${state}`))];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function rows(locale: string, long = false) {
  const text = locale === "ko" ? "답변은 핵심부터 간결하게 써 주세요." : "Start with the main point and keep answers concise.";
  const extended = locale === "ko" ? "\n근거와 예시가 필요하면 빠짐없이 포함해 주세요. 긴 식별자도 끝까지 표시합니다: " : "\nInclude every relevant example and its evidence. Keep long identifiers in full: ";
  return [
    { handle: "R1111111111", text: long ? `${text}${extended}${"memory_identifier_".repeat(90)}\n${text.repeat(12)}` : text, revision: "rev1", project_id: null, scope: { kind: "all" } },
    { handle: "R2222222222", text: locale === "ko" ? "이 프로젝트에서는 접근성을 먼저 확인해 주세요." : "Check accessibility first in this project.", revision: "rev2", project_id: "shot-project", scope: { kind: "project", project_name: "butler-site" }, duration: "7 days", expires_at: new Date(Date.now() + 7 * 86400000).toISOString() },
    { handle: "R3333333333", text: locale === "ko" ? "필요한 변경만 해 주세요." : "Keep changes focused.", revision: "rev3", project_id: "missing", scope: { kind: "session" }, duration: "this chat", expires_at: new Date(Date.now() + 86400000).toISOString() },
  ];
}
function inventory(state: string) {
  const missing = state === "not-measured";
  const kinds = [
    { kind: "pinned", item_count: missing ? null : 3, content_updated_at: now, health: {} },
    { kind: "automatic", item_count: missing ? null : 1284, allocated_bytes: missing ? null : 1.7 * 1024 ** 3, content_updated_at: missing ? null : now, health: { reclaimable_bytes: state === "nothing-to-free" ? 0 : 512 * 1024 ** 2 } },
    { kind: "profile", item_count: missing ? null : 24, pending_count: missing ? null : 6, allocated_bytes: missing ? null : 96 * 1024, content_updated_at: missing ? null : now, health: { consent_on: false } },
    { kind: "project", item_count: 1, health: {} },
  ];
  return { revision: 12, kinds: state === "unavailable" ? [] : kinds,
    operation: state === "cleanup-waiting" || state === "cleanup-running" ? { operation_id: operationId, phase: state === "cleanup-waiting" ? "preparing" : "removing", sequence: 1, bytes_reclaimed: 312 * 1024 ** 2 } : undefined };
}
async function emit(page: Page, phase: string, kind?: string) {
  await page.evaluate(({ phase, operationId, kind }) => {
    const streams = (window as unknown as { memorySmokeStreams: EventSource[] }).memorySmokeStreams;
    for (const stream of streams) stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ id: 10001, type: "memory.operation", payload: { kind, operation_id: operationId, phase, sequence: 2, bytes_reclaimed: 512 * 1024 ** 2 } }) }));
  }, { phase, operationId, kind });
}
async function audit(page: Page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-test-class="instruction-row"]')];
    const text = rows.map((row) => {
      const node = row.querySelector<HTMLElement>('[id^="instruction-text-"]')!;
      const css = getComputedStyle(node);
      return { fullText: css.textOverflow !== "ellipsis" && css.webkitLineClamp === "none", wraps: node.scrollWidth <= node.clientWidth + 1 };
    });
    const surfaces = [...document.querySelectorAll<HTMLElement>('[data-slot="form-section"] [data-kind]')].map((node) => ({ background: getComputedStyle(node).backgroundColor, inset: getComputedStyle(node).padding }));
    const toastFonts = [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].map((node) => getComputedStyle(node).fontFamily);
    return { horizontalScroll: root.scrollWidth > root.clientWidth, text, surfaces, toastFonts };
  });
}
try {
  for (const locale of process.env.BUTLER_MEMORY_ACCEPTANCE_ONLY ? [] : locales) for (const theme of themes) for (const width of [1280, 375]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    for (const state of states.filter((state) => !process.env.BUTLER_MEMORY_SHOT_STATES || process.env.BUTLER_MEMORY_SHOT_STATES.split(",").includes(state))) {
      const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 1400 : 1800 }, reducedMotion: "reduce" });
      await server.signIn(page);
      await page.addInitScript(({ key, value }) => {
        localStorage.setItem(key, value);
        const Original = window.EventSource;
        const streams: EventSource[] = [];
        (window as unknown as { memorySmokeStreams: EventSource[] }).memorySmokeStreams = streams;
        window.EventSource = class extends Original { constructor(url: string | URL, options?: EventSourceInit) { super(url, options); streams.push(this); } };
      }, { key: LEGACY_FIRST_RUN_STORAGE_KEY, value: JSON.stringify(legacyFirstRunCompleteRecord()) });
      let instructionRows = rows(locale, (state === "long" || state === "confirm-long"));
      if (state === "empty") instructionRows = [];
      let reads = 0;
      let finished = false;
      const resetKind = state.includes("profile") ? "profile" : state.includes("project") ? "project_memory" : "automatic";
      let release: (() => void) | undefined;
      const held = new Promise<void>((done) => { release = done; });
      await page.route("**/memory/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const send = async (data: unknown, status = 200) => await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ protocol_version: "butler.app.v1", data }) });
        if (path.startsWith("/memory/reset/") && route.request().method() === "POST") {
          return send({ operation_id: operationId, kind: resetKind, phase: "preparing", sequence: 1 }, 202);
        }
        if (path === "/memory/instructions") {
          if (state === "loading") await held;
          if (state === "load-failure") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Unavailable" } }) });
          return send({ instructions: instructionRows });
        }
        if (route.request().method() === "DELETE" && path.includes("instructions")) {
          if (state === "deleting") await held;
          if (state === "delete-failed") return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "instruction_changed", message: "Changed" } }) });
          instructionRows = instructionRows.filter((row) => !path.endsWith(row.handle));
          return send({ state: "forgotten" });
        }
        if (path.includes("inventory")) { reads++; if (state === "loading") await held; const value = inventory(state === "cleanup-done" && finished ? "nothing-to-free" : state);
          if (finished && state.startsWith("reset") && !state.endsWith("failed")) {
            if (resetKind === "project_memory") value.kinds[0]!.item_count = instructionRows.length;
            else { const card = value.kinds.find(c => c.kind === (resetKind === "profile" ? "profile" : "automatic"))!; card.item_count = 0; card.allocated_bytes = 0; if (card.pending_count != null) card.pending_count = 0; }
          }
          return send(value); }
        if (path.includes("projects")) return send({ project_id: "shot-project", summary_bytes: finished && resetKind === "project_memory" ? null : 18.2 * 1024,
          conversations: finished && resetKind !== "profile" && !state.endsWith("failed") ? 0 : 212,
          instructions: finished && resetKind === "project_memory" && !state.endsWith("failed") ? 0 : 1, updated_at: now });
        if (path === "/memory/cleanup") return send({ operation_id: operationId, phase: "removing", sequence: 1, bytes_reclaimed: 312 * 1024 ** 2 }, 202);
        return send({ cancellation_requested: true });
      });
      await page.route(/\/projects(?:\?.*)?$/, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { projects: state === "no-projects" ? [] : [{ id: "shot-project", display_name: "butler-site" }] } }) }));
      await page.route("**/system-events?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { events: [{ id: "shot-profile", kind: "profile_consolidation", title: "", status: "completed", occurred_at: now, metrics: [{ label: "profiling_enabled", value: true }] }], pagination: { has_more: false } } }) }));
      await page.goto(server.url, { waitUntil: "load" });
      await page.locator('[data-test-class~="composer-card"]').waitFor({ state: "visible" });
      const settingsName = locale === "ko" ? "설정" : "Settings";
      const settingsButton = page.getByRole("button", { name: settingsName, exact: true });
      if (!await settingsButton.isVisible()) await page.getByRole("button", { name: locale === "ko" ? "사이드바 보기" : "Show sidebar", exact: true }).click();
      await settingsButton.click();
      const target = state === "personalization" ? (locale === "ko" ? "개인화" : "Personalization") : state === "system-events" ? (locale === "ko" ? "시스템 이벤트" : "System events") : locale === "ko" ? "기억" : "Memory";
      await page.getByRole("button", { name: target, exact: true }).click();
      const deleteName = locale === "ko" ? "삭제" : "Delete";
      if (["confirm", "confirm-long", "deleting", "deleted", "delete-failed"].includes(state)) {
        await page.locator('[data-test-class="instruction-row"]').first().getByRole("button", { name: deleteName }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.waitFor();
        assert(await dialog.getByRole("button", { name: locale === "ko" ? "취소" : "Cancel" }).evaluate((node) => node === document.activeElement), "Cancel must receive focus");
        if (!["confirm", "confirm-long"].includes(state)) await dialog.getByRole("button", { name: deleteName }).click();
        if (state === "deleting") await page.locator('button[aria-busy="true"]').first().waitFor();
        if (state === "deleted") await page.locator('[data-test-class="instruction-row"]').nth(2).waitFor({ state: "detached" });
        if (state === "delete-failed") await page.getByText(locale === "ko" ? "삭제하지 못했습니다" : "Couldn't delete instruction", { exact: true }).waitFor();
      }
      if (state.startsWith("reset-")) {
        const cardId = resetKind === "profile" ? "profile-memory" : resetKind === "project_memory" ? "project-memory" : "chat-memory";
        const card = page.locator(`[data-settings-section-id="${cardId}"]`);
        await card.getByRole("button", { name: locale === "ko" ? "초기화" : "Reset", exact: true }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.waitFor();
        assert(await dialog.getByRole("button", { name: locale === "ko" ? "취소" : "Cancel" }).evaluate(node => node === document.activeElement), "Reset Cancel receives focus");
        if (!state.endsWith("confirm")) {
          await dialog.getByRole("button", { name: locale === "ko" ? "초기화" : "Reset", exact: true }).click();
          await card.locator('button[aria-busy="true"]').waitFor();
          await dialog.waitFor({ state: "detached" });
          await page.waitForFunction((id) => document.querySelector(`[data-settings-section-id="${id}"] button[aria-busy="true"]`) === document.activeElement, cardId);
          if (!state.endsWith("running")) {
            finished = true;
            if (resetKind === "project_memory" && state.endsWith("done")) instructionRows = instructionRows.filter(row => row.project_id !== "shot-project");
            await emit(page, state.endsWith("failed") ? "failed" : "complete", resetKind);
            await page.getByText(locale === "ko" ? state.endsWith("failed") ? "초기화하지 못했습니다" : `${resetKind === "profile" ? "프로필" : resetKind === "project_memory" ? "프로젝트 기억" : "대화 기억"}을 초기화했습니다`
              : state.endsWith("failed") ? "Couldn't reset" : `${resetKind === "profile" ? "Profile" : resetKind === "project_memory" ? "Project memory" : "Chat memory"} reset`, { exact: true }).waitFor();
            assert(await card.locator('button[aria-disabled]').evaluate(node => node === document.activeElement), "Reset retains toolbar focus after completion");
          }
        }
      }
      if (["cleanup-done", "cleanup-stopped", "cleanup-cancelled"].includes(state)) {
        await page.getByRole("button", { name: locale === "ko" ? "공간 정리" : "Free up space", exact: true }).click();
        await page.getByRole("status").filter({ hasText: locale === "ko" ? "공간 정리 중" : "Freeing up space" }).waitFor();
        finished = true;
        await emit(page, state === "cleanup-done" ? "complete" : state === "cleanup-stopped" ? "failed" : "cancelled");
        await page.getByText(locale === "ko" ? (state === "cleanup-done" ? "공간 정리 완료 · 512.0 MB 확보" : state === "cleanup-stopped" ? "공간 정리 중단 · 512.0 MB 확보" : "공간 정리 취소 · 512.0 MB 확보") : state === "cleanup-done" ? "Freed up 512.0 MB" : state === "cleanup-stopped" ? "Couldn't finish. Freed up 512.0 MB." : "Cancelled. Freed up 512.0 MB.", { exact: true }).waitFor();
      }
      if (!(["personalization", "system-events", "loading"].includes(state))) {
        await page.locator('[data-settings-section-id="profile-memory"]').waitFor();
        await page.waitForFunction(() => document.querySelector('[data-settings-section-id="instructions"]')?.getAttribute("aria-busy") !== "true");
      }
      if (state === "personalization") await page.locator('[data-setting-id="memory-link"]').scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState !== "running"));
      const beforeIdle = reads;
      if (state === "populated") { await page.waitForTimeout(1000); assert(reads === beforeIdle && reads === 1, `one opening check, no polling: ${reads}`); }
      const checks = { ...await audit(page), design: await auditMemoryDesign(page) };
      assert(checks.design.scrollers.every(row => !row.horizontal && (!row.scrollable || row.mask !== "none")), "scroll overflow needs a fade");
      assert(checks.design.notices.every(row => row.outer === "flex-start" && row.content === "flex-start"), "Notice content and action must be top aligned");
      assert(checks.design.cardContrast.every(row => row.card.some((c, i) => Math.abs(c - row.surround[i]!) > 1)), "cards must contrast with the surrounding surface");
      assert(checks.design.labelsAboveControls.every(Boolean), "Settings labels must sit above controls");
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      assert(viewportWidth === width, `viewport ${viewportWidth} expected ${width}`);
      if (state === "populated") {
        const captions = (await page.locator('[data-test-class="instruction-row"] [data-tone="secondary"]').allTextContents()).map((value) => value.trim());
        const expected = locale === "ko"
          ? ["모든 채팅", "butler-site · 7일 후 만료", "이 채팅에서만"]
          : ["All chats", "butler-site · Expires in 7 days", "This chat only"];
        assert(JSON.stringify(captions) === JSON.stringify(expected), `instruction captions ${locale}: ${JSON.stringify(captions)}`);
      }
      const expectedInset = width <= 760 ? "16px" : "24px";
      assert(checks.design.padding.every(row => row.values.every(v => v === expectedInset)), `card insets ${locale}/${theme}/${width}, expected ${expectedInset}: ${JSON.stringify(checks.design.padding)}`);
      assert(checks.design.minimumTextContrast == null || checks.design.minimumTextContrast >= 4.5, `text contrast ${checks.design.minimumTextContrast}`);
      assert(!checks.horizontalScroll && checks.text.every((row) => row.fullText && row.wraps), `overflow or truncated text: ${JSON.stringify(checks)}`);
      assert(checks.toastFonts.every((font) => font.includes("Pretendard")), `toast must use bundled font: ${JSON.stringify(checks.toastFonts)}`);
      const file = `memory-${locale}-${theme}-${width}-${state}.png`;
      await page.screenshot({ path: resolve(output, file), fullPage: true });
      report.push({ file, result: "pass", audit: checks });
      release?.();
      await page.close();
      console.log(file);
    }
  }
  {
    await checkProfileInstructionSeparation(server, browser);
    await checkMemoryRefreshDuringRead(server, browser);
  }
} finally {
  writeFileSync(resolve(output, "memory-screenshot-checks.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await server.stop();
}
