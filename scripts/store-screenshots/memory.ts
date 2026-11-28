import assert from "node:assert/strict";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import type { ElectronPage } from "../../tests/support/electron-page-cdp.ts";
import { type Api, type App, type Locale, until } from "./app.ts";
import type { Demo } from "./demo.ts";
import { click } from "./ui.ts";

export type MemoryProgress = { state: string; reason?: string; bytes_done: number; bytes_total: number };
type Consolidation = {
  active: { operation_id: string } | null;
  last_run: { at: string; status: string; trigger: string; message?: string } | null;
};
type Inventory = {
  operation?: { phase: string } | null;
  kinds: { kind: string; health: { queueBacklog?: number; serving?: { oldest_pending_age_ms?: number | null } } }[];
};
type Facts = { memoryModel: unknown; memoryRun: unknown };

const instructions = '[data-settings-section-id="instructions"]';
const patterns = '[data-settings-section-id="noticed-patterns"]';
const storage = '[data-settings-section-id="chat-memory"] [data-setting-id="free-space"]';
const profile = '[data-settings-section-id="profile-memory"] [data-setting-id="reset-profile"]';
const scrollArea = '[data-test-class="settings-detail-scroll"]';
const settingsNav = '[data-test-class="settings-sidebar"] :is(button, [role=button])';
const runButton = '[data-setting-id="consolidation-run"] button';

async function awaitMemory(api: Api, facts: Facts) {
  await until(async () => {
    const { memory_model: model } = await api<{ memory_model?: MemoryProgress }>("/setup/readiness");
    facts.memoryModel = model ?? null;
    assert(!model || !["failed", "off"].includes(model.state), `Embedding setup ended in ${model?.state}: ${model?.reason ?? ""}`);
    return model?.state === "ready";
  }, "embedding model readiness", 600_000);
}

async function waitForMemoryIdle(api: Api) {
  await until(async () => {
    if ((await api<Consolidation>("/memory/consolidation")).active) return false;
    // Inventory measurement acquires the memory writer lease and reports work in the sync queue.
    const inventory = await api<Inventory>("/memory/inventory/check", "POST", {}).catch((error: unknown) => {
      if (String(error).endsWith("returned HTTP 409")) return null;
      throw error;
    });
    if (!inventory || (inventory.operation && !["complete", "failed", "cancelled"].includes(inventory.operation.phase))) return false;
    const health = inventory.kinds.find(card => card.kind === "automatic")?.health;
    return health?.queueBacklog === 0 && health.serving?.oldest_pending_age_ms == null;
  }, "idle memory sync and consolidation", 90_000);
}

async function resetMemoryView(page: ElectronPage, locale: Locale) {
  const copy = getAppCopy(locale.locale).settings.sections;
  await click(page, copy.general, settingsNav);
  await page.waitForFunction(selector => !document.querySelector(selector), runButton);
  await click(page, copy.memory, settingsNav);
}

async function runConsolidation(app: App, api: Api, locale: Locale) {
  const { page } = app;
  const copy = getAppCopy(locale.locale).settings.memory;
  const deadline = Date.now() + 120_000;
  let retries = 0;
  while (Date.now() < deadline) {
    await waitForMemoryIdle(api);
    const before = (await api<Consolidation>("/memory/consolidation")).last_run?.at;
    await click(page, copy.runNow, runButton);
    const result = await until<NonNullable<Consolidation["last_run"]> | "busy">(async () => {
      const status = await page.evaluate(() => ({
        button: document.querySelector('[data-setting-id="consolidation-run"] button')?.getAttribute("aria-label"),
        toast: [...document.querySelectorAll<HTMLElement>('[data-sonner-toast][data-visible="true"]')].map(toast => toast.innerText).join("\n"),
      }));
      const { active, last_run: last } = await api<Consolidation>("/memory/consolidation");
      if (!active && last && last.at !== before && last.trigger === "manual") return last;
      assert(!status.toast.includes(copy.consolidationFailed), "Memory consolidation failed in Settings");
      // useConsolidation sets this disabled label only for the POST's writer-busy 409.
      return !active && status.button === `${copy.runNow}. ${copy.inUse}` && "busy";
    }, "completion of the Run now action", Math.max(200, deadline - Date.now()));
    if (result !== "busy") {
      assert.equal(result.status, "ok", result.message ?? "Memory consolidation failed");
      return { ...result, writerBusyRetries: retries };
    }
    retries++;
    await resetMemoryView(page, locale);
  }
  throw new Error("Memory consolidation kept returning writer-busy HTTP 409");
}

export async function prepareMemory(app: App, api: Api, words: Demo, locale: Locale, facts: Facts) {
  const imported = await api<{ stable_entry_count: number }>("/personalization/profile-import", "POST", { text: words.profileImport });
  assert(imported.stable_entry_count >= 1, "Profile import returned no stable entries");
  await awaitMemory(api, facts);
  const copy = getAppCopy(locale.locale);
  await click(app.page, copy.sidebar.settings);
  await click(app.page, copy.settings.sections.memory, settingsNav);
  facts.memoryRun = await runConsolidation(app, api, locale);
  await resetMemoryView(app.page, locale);
  await app.page.waitForFunction(({ instructions, patterns, profile, storage, rules, titles, entries, notMeasured }) => {
    const contains = (selector: string, texts: readonly string[]) =>
      texts.every(text => document.querySelector<HTMLElement>(selector)?.innerText.includes(text));
    return contains(instructions, rules) && contains(patterns, titles) && contains(profile, [entries]) &&
      Boolean(document.querySelector(`${storage} dl`) || contains(storage, [notMeasured]));
  }, { instructions, patterns, profile, storage, rules: words.memory, titles: words.patterns.map(([title]) => title),
    entries: copy.settings.memory.facts.entries, notMeasured: copy.settings.memory.notMeasured });
}

export async function frameMemory(page: ElectronPage, words: Demo, locale: Locale) {
  const copy = getAppCopy(locale.locale).settings.memory;
  const options = { instructions, patterns, storage, profile, scrollArea, chats: copy.facts.chats,
    entries: copy.facts.entries, notMeasured: copy.notMeasured };
  const frame = await page.expression<{
    targetScrollTop: number; scrollTop: number; chatCount: number | null; profileCount: number | null;
    chatMemoryNotMeasured: boolean; instructions: Record<string, boolean>; patterns: Record<string, boolean>; storageFactsVisible: boolean;
  }>(`(async () => {
    const selectors = ${JSON.stringify(options)};
    const scroll = document.querySelector(selectors.scrollArea);
    const instructionSection = scroll?.querySelector(selectors.instructions);
    const ruleRows = [...(instructionSection?.querySelectorAll('[data-test-class="instruction-row"]') ?? [])];
    const patternRows = [...(scroll?.querySelectorAll(selectors.patterns + ' [data-test-class="pattern-row"]') ?? [])];
    const storage = scroll?.querySelector(selectors.storage);
    const unmeasured = [...(storage?.querySelectorAll('*') ?? [])].find(node => node.innerText === selectors.notMeasured);
    const facts = storage?.querySelector('dl') ?? unmeasured;
    if (!scroll || !instructionSection || !ruleRows.length || !facts) throw new Error('Memory sections are missing');
    const rect = node => node.getBoundingClientRect();
    const viewportTop = () => rect(scroll).top + scroll.clientTop;
    const position = (node, edge) => rect(node)[edge] - viewportTop() + scroll.scrollTop;
    const preferred = Math.max(0, Math.floor(position(instructionSection, 'top') - 16));
    const needed = Math.ceil(position(facts, 'bottom') - scroll.clientHeight);
    const limit = Math.floor(position(ruleRows[0], 'top') - 8);
    const targetScrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, Math.max(preferred, Math.min(needed, limit))));
    scroll.scrollTo({ top: targetScrollTop, behavior: 'instant' });
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    if (!scroll.isConnected || !facts.isConnected) throw new Error('Memory scroll container was replaced during capture');
    const visible = node => {
      if (!node?.checkVisibility()) return false;
      const bounds = rect(node);
      return bounds.height > 0 && bounds.top >= viewportTop() && bounds.bottom <= viewportTop() + scroll.clientHeight;
    };
    const namedRows = (names, rows) => Object.fromEntries(names.map(name => [
      name, visible(rows.find(row => row.innerText.includes(name))),
    ]));
    const count = (section, label) => {
      const raw = [...(section?.querySelectorAll('dt') ?? [])].find(dt => dt.innerText === label)?.nextElementSibling?.innerText;
      return raw && /^[\\d,.\\s]+$/.test(raw) ? Number(raw.replace(/[,\\s]/g, '')) : null;
    };
    const chatCount = count(storage, selectors.chats);
    return {
      targetScrollTop, scrollTop: scroll.scrollTop, chatCount,
      profileCount: count(scroll.querySelector(selectors.profile), selectors.entries),
      chatMemoryNotMeasured: chatCount === null || Boolean(unmeasured),
      instructions: namedRows(${JSON.stringify(words.memory)}, ruleRows),
      patterns: namedRows(${JSON.stringify(words.patterns.map(([title]) => title))}, patternRows),
      storageFactsVisible: visible(facts),
    };
  })()`);
  assert.equal(frame.scrollTop, frame.targetScrollTop, "Memory scroll changed before capture");
  assert(frame.profileCount !== null && frame.profileCount >= 1, "The rendered profile card has no entries");
  assert(Object.values(frame.instructions).every(Boolean), "Both instruction rows must be fully visible");
  assert(Object.values(frame.patterns).every(Boolean), "Both pattern rows must be fully visible");
  return frame;
}
