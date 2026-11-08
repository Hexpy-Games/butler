// UI behavior E2E: product conversation and board cards, offline gateway, no model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { appliedProposal, epicCards, epicOrder, epicOverview } from "../support/answer-epics-fixture";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types";

const root = process.cwd();
const evidence = process.env.BUTLER_ANSWER_EVIDENCE ?? mkdtempSync(join(tmpdir(), "answer-epics-ui-"));
mkdirSync(evidence, { recursive: true });
process.chdir(join(root, "packages/butler-app/client/ui"));
// Reference cards and store access stay in the smoke, using the product modules.
const reference = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {EpicCard} from '/src/components/canon/EpicCard.tsx';
import {Grid} from '/src/libs/design-system/index.ts';
import {ChatEpicCards} from '/src/components/canon/ChatEpicCards.tsx';
export {useButlerStore} from '/src/app/store.ts';
export {publishCanonEvent} from '/src/app/canonEvents.ts';
export {publishCanonProposalEvent} from '/src/app/canonProposals.ts';
export function mount(cards) { const node=document.createElement('div'); node.id='board-reference'; document.body.append(node);
createRoot(node).render(<Grid columns="auto-fill" gap="sm">{cards.map(epic=><EpicCard key={epic.id} epic={epic} selected={false} onSelect={()=>{}} />)}</Grid>); }
export function mountShared() { const node=document.createElement("div"); node.id="shared-cards"; document.body.append(node);
const root=createRoot(node); root.render(<><ChatEpicCards projectId="shared" ids={["release"]}/><ChatEpicCards projectId="shared" ids={["docs"]}/></>);
return ()=>{root.unmount();node.remove();}; }`;
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{ name: "epic-reference",
  resolveId(id) { if (id === "/epic-reference.tsx") return id; }, load(id) { if (id === "/epic-reference.tsx") return reference; },
}] });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let background = "plain", state: "ready" | "missing" | "error" = "ready";
const overview = structuredClone(epicOverview);
let canonReads = 0, sharedReads = 0;
let fixture: "answer" | "proposal" | "receipt" = "answer";
const create = (id: string) => ({ op: "epic.create", id, title: id }), edit = (id: string) => ({ op: "epic.edit", id, title: id });
const receipts = {
  added: { proposals: { registration: ["release", "docs", "cancelled"].map(create) }, reply: ["docs", "release", "cancelled"], title: "과제 3개 등록" },
  edited: { proposals: { renamed: ["docs", "release"].map(edit) }, reply: [], title: "과제 2개 변경" },
  mixed: { proposals: { registration: [create("release")], renamed: [edit("docs")] }, reply: epicOrder, title: "과제 1개 등록, 1개 변경" },
};
let receipt: keyof typeof receipts = "added";
let proposalState: "open" | "applied" = "applied";
const errors: string[] = [];
const message = (): MessageRecord => ({ id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered", text: "요청한 과제를 확인했습니다.", created_at: "2026-11-02T08:00:00Z",
  ...(fixture === "proposal" ? { canon_proposals: [{ proposal_id: "registration", turn_id: "turn", source_call_id: "create", epic_ids: [] }] } : {}),
  ...(fixture === "receipt" ? { canon_proposals: Object.entries(receipts[receipt].proposals).map(([id, changes]) => ({ proposal_id: id, turn_id: "turn", source_call_id: id, epic_ids: changes.map(change => change.id) })) } : {}),
  ...(fixture === "answer" || (fixture === "receipt" && receipts[receipt].reply.length) ? { answer_blocks: [{ call_id: "epics", set_ids: [], spec: { v: 2, blocks: [{ type: "epics", project_id: "butler", ids: fixture === "receipt" ? receipts[receipt].reply : epicOrder }] } }] } : {}) });
async function open(page: Page, base: string, width: number, theme: string, wall: string) {
  background = wall;
  await page.setViewportSize({ width, height: 1100 });
  await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
  await page.locator('[data-test-class="turn-result-section"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}
async function captureCards(page: Page, theme: string) {
  const cards = page.locator('[data-test-class="chat-epic-cards"] [data-kanban-item]');
  await page.evaluate(async data => {
    const module = await import(/* @vite-ignore */ String("/epic-reference.tsx")); module.mount(data);
  }, epicCards);
  const refs = page.locator('#board-reference [data-kanban-item]');
  await refs.first().waitFor();
  for (let i = 0; i < 3; i++) {
    const id = epicOrder[i];
    assert.equal(await cards.nth(i).getAttribute("data-kanban-item"), id);
    const board = page.locator(`#board-reference [data-kanban-item="${id}"]`);
    // React-generated aria ids vary per mount; all content, slots and hierarchy must match.
    const structure = (node: Element): string => {
      const clone = node.cloneNode(true) as Element;
      clone.querySelector('[data-test-class="canon-epic-status"]')?.remove();
      for (const child of [clone, ...clone.querySelectorAll("*")]) for (const attr of [...child.attributes]) {
        if (attr.name === "id" || attr.name.startsWith("aria-describedby")) child.removeAttribute(attr.name);
      }
      return clone.outerHTML;
    };
    assert.deepEqual([await cards.nth(i).locator('[data-test-class="canon-epic-status"]').count(), await board.locator('[data-test-class="canon-epic-status"]').count()], [1, Number(epicCards.find(epic => epic.id === id)!.canon_status === "cancelled")]);
    const text = (node: HTMLElement): string => {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelector('[data-test-class="canon-epic-status"]')?.remove();
      return clone.textContent ?? "";
    };
    assert.equal(await cards.nth(i).evaluate(text), await board.evaluate(text));
    assert.equal(await cards.nth(i).evaluate(structure), await board.evaluate(structure));
  }
  const first = cards.first(), board = page.locator('#board-reference [data-kanban-item="docs"]');
  const width = (await first.boundingBox())!.width;
  await board.evaluate((node, w) => { (node as HTMLElement).style.width = `${w}px`; }, width);
  await first.screenshot({ path: join(evidence, `chat-card-${theme}.png`) });
  await board.screenshot({ path: join(evidence, `board-card-${theme}.png`) });
  await page.locator('#board-reference').evaluate(node => node.remove());
  await page.getByText("삭제된 과제", { exact: true }).locator("..").screenshot({ path: join(evidence, `chat-deleted-${theme}.png`) });
  await page.keyboard.press("Tab"); await first.getByRole("button").focus();
  const box = (await first.boundingBox())!;
  const room = await first.evaluate(node => Number.parseFloat(getComputedStyle(node).getPropertyValue("--focus-ring-room")) || 4);
  await page.screenshot({ path: join(evidence, `chat-focus-${theme}.png`), clip: { x: box.x - room, y: box.y - room, width: box.width + room * 2, height: box.height + room * 2 } });
}
async function navigation(page: Page, open: () => Promise<void>, epicId: string) {
  await open();
  await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
  await page.getByRole("tab", { name: "보드", selected: true }).waitFor();
  await page.locator('[data-test-class="project-dashboard-view"] [role="tabpanel"] [data-kanban-item="' + epicId + '"]').waitFor();
  assert.deepEqual(await page.evaluate(async () => {
    const { useButlerStore } = await import(/* @vite-ignore */ String("/epic-reference.tsx")); return useButlerStore.getState().view;
  }), { kind: "project-dashboard", projectId: "butler", epicId });
}
try {
  await vite.listen(); const base = vite.resolvedUrls!.local[0];
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ deviceScaleFactor: 2, reducedMotion: "reduce", locale: "ko-KR" });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    const ok = (data: unknown) => route.fulfill({ json: { ok: true, data } });
    if (url.pathname === "/") {
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify({ messages: [message()], background }).replaceAll("<", "\\u003c")}</script>`) });
    }
    if (url.pathname === "/projects/shared/canon") { sharedReads++; return ok(overview); }
    if (url.pathname === "/projects/butler/canon") {
      canonReads++;
      if (state !== "ready") return route.fulfill({ status: state === "missing" ? 404 : 500, json: { ok: false, error: { code: state === "missing" ? "project_not_found" : "unavailable" } } });
      return ok(overview);
    }
    if (url.pathname === "/projects/butler/canon/sidebar") return ok({ project_id: "butler", groups: [] });
    if (fixture === "receipt" && url.pathname.startsWith("/canon/proposals/")) { const id = url.pathname.split("/")[3]; return ok({ ...appliedProposal, proposal_id: id, changes: (receipts[receipt].proposals as Record<string, unknown[]>)[id] }); }
    if (url.pathname === "/canon/proposals/registration") {
      if (route.request().method() === "POST") { proposalState = "applied"; return ok({ ok: true }); }
      return ok({ ...appliedProposal, state: proposalState });
    }
    if (url.pathname === "/personalization") return ok({ profile: { principal_name: "나" } });
    if (url.pathname.startsWith("/canon/epics/")) {
      const id = url.pathname.split("/")[3]; const epic = epicCards.find(epic => epic.id === id)!;
      return ok(url.pathname.endsWith("/progress") ? { epic_id: id, stage: null, stage_history: [], actions: [], counts: { completed: 0, total: 0 }, running: false, disposition: null } : { ...epic, specs: [], tasks: [], attachments: [] });
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return ok({ session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } });
    if (url.pathname === "/session-queue") return ok({ queued_messages: [] });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return ok({});
    return route.continue();
  });
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const wall of ["plain", "wallpaper"]) {
    await open(page, base, width, theme, wall);
    const grid = page.locator('[data-test-class="chat-epic-cards"]');
    await grid.locator('[data-kanban-item]').first().waitFor();
    assert.equal(await grid.locator('[data-kanban-item]').count(), 3);
    assert.equal(await grid.getByText("삭제된 과제", { exact: true }).count(), 1);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const boxes = await grid.locator('[data-kanban-item]').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, width: node.getBoundingClientRect().width })));
    if (width === 390) assert(boxes.every(box => Math.abs(box.x - boxes[0].x) < 1) && boxes[1].y > boxes[0].y, "phone cards fill one column");
    await grid.screenshot({ path: join(evidence, `chat-${width}-${theme}-${wall}.png`) });
    if (width === 1440 && wall === "plain") await captureCards(page, theme);
  }
  const docsCard = () => page.locator('[data-test-class="chat-epic-cards"] [data-kanban-item="docs"]').getByRole("button");
  await navigation(page, () => docsCard().click(), "docs");
  await open(page, base, 1440, "light", "plain");
  await navigation(page, async () => { const card = docsCard(); await card.focus(); await card.press("Enter"); }, "docs");
  fixture = "proposal";
  for (const theme of ["light", "dark"]) {
    await open(page, base, 1440, theme, "plain");
    await page.locator('[data-test-class="chat-epic-cards"] [data-kanban-item="release"]').waitFor();
    await page.locator('[data-test-class="canon-proposal-card"]').locator("..").screenshot({ path: join(evidence, `proposal-applied-${theme}.png`) });
  }
  fixture = "receipt";
  for (const name of Object.keys(receipts) as (keyof typeof receipts)[]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    receipt = name;
    const { proposals, reply, title } = receipts[name];
    const owned = [...new Set(Object.values(proposals).flat().map(change => change.id))];
    await open(page, base, width, theme, "plain");
    const card = page.locator('[data-test-class="canon-proposal-card"]');
    await card.getByText(title, { exact: true }).waitFor();
    await card.locator("[data-kanban-item]").nth(owned.length - 1).waitFor();
    assert.equal(await card.count(), 1, "a reply's applied proposals share one receipt");
    assert.deepEqual(await card.locator("[data-kanban-item]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-kanban-item"))), owned, "the receipt holds every 과제 it touched");
    for (const id of owned) assert.equal(await page.locator(`[data-kanban-item="${id}"]`).count(), 1, `${id} renders once`);
    assert.equal(await page.locator('[data-answer-block="epics"]').count(), reply.some(id => !owned.includes(id)) ? 1 : 0, "the reply keeps only 과제 the receipt does not show");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await card.locator('xpath=ancestor::*[contains(normalize-space(.), "요청한 과제를 확인했습니다.")][1]').screenshot({ path: join(evidence, `receipt-${name}-${width}-${theme}.png`) });
  }
  fixture = "proposal";
  await open(page, base, 1440, "light", "plain");
  await navigation(page, () => page.locator('[data-test-class="canon-proposal-card"]').getByRole("button", { name: "열기", exact: true }).click(), "release");
  proposalState = "open";
  await open(page, base, 1440, "light", "plain");
  await page.locator('[data-test-class="canon-proposal-card"][data-state="open"]').waitFor();
  assert.equal(await page.locator('[data-test-class="chat-epic-cards"]').count(), 0, "drafts keep their existing view");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.locator('[data-test-class="canon-proposal-card"][data-state="applied"]').waitFor();
  await page.locator('[data-test-class="chat-epic-cards"] [data-kanban-item="release"]').waitFor();
  fixture = "answer";
  await open(page, base, 1440, "light", "plain");
  await page.locator('[data-kanban-item="release"]').waitFor();
  await page.evaluate(async () => {
    const module = await import(/* @vite-ignore */ String("/epic-reference.tsx"));
    (window as Window & { unmountCards?: () => void }).unmountCards = module.mountShared();
  });
  await page.locator('#shared-cards [data-kanban-item="docs"]').waitFor();
  assert.equal(sharedReads, 1, "mounted blocks share one initial project read");
  overview.backlog[0].title = "최신 릴리스 확인";
  await page.evaluate(async () => { const { publishCanonEvent } = await import(/* @vite-ignore */ String("/epic-reference.tsx")); publishCanonEvent({ type: "canon.changed", payload: { project_id: "shared" } }); });
  await page.locator("#shared-cards").getByText("최신 릴리스 확인", { exact: true }).waitFor();
  assert.equal(sharedReads, 2, "mounted blocks share one refresh per change");
  await page.evaluate(async () => {
    (window as Window & { unmountCards?: () => void }).unmountCards?.();
    const { publishCanonEvent } = await import(/* @vite-ignore */ String("/epic-reference.tsx")); publishCanonEvent({ type: "canon.changed", payload: { project_id: "shared" } });
  });
  assert.equal(sharedReads, 2, "the last unmount unsubscribes");
  state = "missing";
  await open(page, base, 390, "light", "plain");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="chat-epic-cards"] *')].filter(node => node.textContent === "삭제된 과제" && !node.children.length).length === 4);
  await page.goto(`${base}?visual=components&theme=light&locale=en`);
  await page.getByText("Deleted task", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Deleted task", { exact: true }).count(), 4);
  state = "error";
  await open(page, base, 390, "dark", "plain");
  await page.locator('[data-test-class="chat-epic-cards"]').waitFor({ state: "detached" });
  assert.equal(await page.locator('[data-answer-block="epics"]').count(), 0, "a failed project read leaves no empty block actions");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, evidence, canonReads, modelCalls: 0 }));
} finally { await browser?.close(); await vite.close(); }
