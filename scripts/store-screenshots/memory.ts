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
  kinds: { kind: string; health: Record<string, unknown> }[];
};
type Facts = { memoryModel: unknown; memoryRun: unknown };
export type MemoryDiagnostics = {
  consolidation?: Consolidation;
  ui?: Awaited<ReturnType<typeof readRunNow>>;
};

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

async function waitForMemoryIdle(api: Api, diagnostics: MemoryDiagnostics, deadline: number) {
  return until(async () => {
    const status = diagnostics.consolidation = await api<Consolidation>("/memory/consolidation");
    return status.active === null && status;
  }, "no active memory consolidation", Math.min(60_000, deadline - Date.now()));
}

function readRunNow(page: ElectronPage) {
  return page.expression<{ runNowAriaLabel: string | null; visibleToasts: string[] }>(`({
    runNowAriaLabel: document.querySelector(${JSON.stringify(runButton)})?.getAttribute("aria-label") ?? null,
    visibleToasts: [...document.querySelectorAll('[data-sonner-toast][data-visible="true"]')].map(toast => toast.innerText),
  })`);
}

export async function memoryTimeout(error: unknown, app: App | undefined, api: Api | undefined,
  facts: Facts, diagnostics: MemoryDiagnostics) {
  if (!/timed out|timeout|did not become ready/iu.test(String(error))) return error;
  const [consolidation, ui] = await Promise.all([
    api?.<Consolidation>("/memory/consolidation").catch(() => diagnostics.consolidation),
    app ? readRunNow(app.page).catch(() => diagnostics.ui) : diagnostics.ui,
  ]);
  // Measuring inventory takes the writer lease, so sample it only after a timeout.
  const inventory = await api?.<Inventory>("/memory/inventory/check", "POST", {}).catch((cause: unknown) => ({
    error: app?.safe(String(cause)) ?? String(cause),
  }));
  const snapshot = {
    consolidation: consolidation ?? diagnostics.consolidation ?? null,
    automaticHealth: inventory && "kinds" in inventory ? inventory.kinds.find(card => card.kind === "automatic")?.health ?? null : null,
    inventoryCheckError: inventory && "error" in inventory ? inventory.error : null,
    runNowAriaLabel: ui?.runNowAriaLabel ?? null,
    visibleToasts: ui?.visibleToasts ?? null,
  };
  facts.memoryRun = { result: facts.memoryRun, timeout: snapshot };
  return new Error(`${error instanceof Error ? error.message : String(error)}. Memory diagnostics: ${JSON.stringify(snapshot)}`, { cause: error });
}

async function resetMemoryView(page: ElectronPage, locale: Locale) {
  const copy = getAppCopy(locale.locale).settings.sections;
  await click(page, copy.general, settingsNav);
  await page.waitForFunction(selector => !document.querySelector(selector), runButton);
  await click(page, copy.memory, settingsNav);
}

async function runConsolidation(app: App, api: Api, locale: Locale, diagnostics: MemoryDiagnostics) {
  const { page } = app;
  const copy = getAppCopy(locale.locale).settings.memory;
  const deadline = Date.now() + 300_000;
  let retries = 0;
  while (Date.now() < deadline) {
    const before = (await waitForMemoryIdle(api, diagnostics, deadline)).last_run?.at;
    if (Date.now() >= deadline) break;
    await click(page, copy.runNow, runButton);
    const result = await until<NonNullable<Consolidation["last_run"]> | "busy">(async () => {
      const ui = diagnostics.ui = await readRunNow(page);
      const { active, last_run: last } = diagnostics.consolidation = await api<Consolidation>("/memory/consolidation");
      if (!active && last && last.at !== before && last.trigger === "manual") return last;
      assert(!ui.visibleToasts.some(toast => toast.includes(copy.consolidationFailed)), "Memory consolidation failed in Settings");
      // useConsolidation sets this disabled label only for the POST's writer-busy 409.
      return !active && ui.runNowAriaLabel === `${copy.runNow}. ${copy.inUse}` && "busy";
    }, "completion of the Run now action", deadline - Date.now());
    if (result !== "busy") {
      assert.equal(result.status, "ok", result.message ?? "Memory consolidation failed");
      return { ...result, writerBusyRetries: retries };
    }
    retries++;
    if (Date.now() >= deadline) break;
    await resetMemoryView(page, locale);
  }
  throw new Error(`Timed out running memory consolidation after ${retries} writer-busy retries`);
}

export async function prepareMemory(app: App, api: Api, words: Demo, locale: Locale, facts: Facts, diagnostics: MemoryDiagnostics) {
  const imported = await api<{ stable_entry_count: number }>("/personalization/profile-import", "POST", { text: words.profileImport });
  assert(imported.stable_entry_count >= 1, "Profile import returned no stable entries");
  await awaitMemory(api, facts);
  const copy = getAppCopy(locale.locale);
  await click(app.page, copy.sidebar.settings);
  await click(app.page, copy.settings.sections.memory, settingsNav);
  facts.memoryRun = await runConsolidation(app, api, locale, diagnostics);
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
    // Scroll far enough that the last noticed item is whole too (125% display scale, run 46134374438).
    const lastPattern = patternRows.at(-1);
    const bottomFit = lastPattern ? Math.ceil(position(lastPattern, 'bottom') + 24 - scroll.clientHeight) : 0;
    const targetScrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, Math.max(preferred, bottomFit)));
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
