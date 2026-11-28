import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeOnboardingComplete } from "../../tests/support/native-app-server.ts";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { type Api, type App, type Locale, locales, redact, startApp, until } from "./app.ts";
import { assertOrganized, chatOrder, createSchedules, demo, demoModel, demoRoot, populateDemoFiles, startDemoStub, type Chat } from "./demo.ts";
import { focus, shotRecorder } from "./shots.ts";
import { frameMemory, memoryTimeout, prepareMemory, type MemoryDiagnostics, type MemoryProgress } from "./memory.ts";
import { approval, assertBrowserStills, assertDesktopLayout, assertModelChip, browserShot, click, firstRun, openBrowserPane, openChat, organized, pendingZip, readApprovalCard, schedulesShot, storeScale, storeTextSize, verifyTextSize, verifyTheme } from "./ui.ts";

type Words = ReturnType<typeof demo>;
type Recorder = ReturnType<typeof shotRecorder>;
type Stub = Awaited<ReturnType<typeof startDemoStub>>;
type Authority = { request_ref: string; executable?: string; approval?: { operation?: { command?: string; tool?: string } } };
type TurnView = { latest_turn?: { state: string; safe_error_code?: string }; authority_requests?: Authority[] };

function cardTool(title: string, locale: Locale, candidates: string[]) {
  const copy = getAppCopy(locale.locale);
  const labels = copy.interfaceTemplates.approvalRequest;
  if (title === labels.runCommandOutside || title === labels.runCommand(null)) return "run_command";
  return candidates.find(tool => {
    const label = copy.guided.tools[tool];
    return label && (title === labels.operation(label, true) || title === labels.operation(label, false));
  }) ?? "";
}

async function chatTimeout(app: App, chat: Chat, view: TurnView) {
  const requests = view.authority_requests ?? [];
  const cardInDom = await app.page.expression<boolean>(`Boolean(document.querySelector(${JSON.stringify(approval)}))`).catch(() => null);
  return `scripted chat ${chat}: ${JSON.stringify({
    latest_turn: { state: view.latest_turn?.state ?? null },
    authority_requests: { count: requests.length, tools: requests.map(request => ({
      executable: request.executable ?? null, "operation.tool": request.approval?.operation?.tool ?? null,
    })) },
    view_keys: Object.keys(view), card_in_dom: cardInDom,
  })}`;
}

async function playChat(app: App, api: Api, locale: Locale, words: Words, stub: Stub, chat: Chat) {
  const [title, text] = words[chat];
  const { session } = await api<{ session: { id: string } }>("/sessions", "POST", { kind: "chat", title });
  await openChat(app.page, title);
  if (chat === "C") await openBrowserPane(app.page);
  stub.select(chat);
  await api("/messages", "POST", { chat_id: session.id, text, client_message_id: crypto.randomUUID() });
  const answered = new Set<string>();
  const allowed: Record<Chat, string[]> = {
    D: ["update_explicit_memory"], C: ["tool_call", "browser_open", "browser_observe", "browser_act"],
    A: ["list_files", "run_command"], B: [],
  };
  const allowLabel = getAppCopy(locale.locale).interfaceDetails.allowOnce;
  let lastView: TurnView = {};
  await until(async () => {
    stub.check(chat);
    const view = lastView = await api<TurnView>(`/session-view?session_id=${encodeURIComponent(session.id)}`);
    const state = view.latest_turn?.state;
    if (state === "delivered") {
      assert(chat !== "B", "Zip turn finished without the expected approval");
      return true;
    }
    if (state && ["failed", "cancelled", "runtime_fault"].includes(state)) {
      throw new Error(`Chat ${chat} ended ${state}: ${view.latest_turn?.safe_error_code ?? "no error code"}`);
    }
    const pending = view.authority_requests?.find(request => !answered.has(request.request_ref));
    const card = pending ? null : await readApprovalCard(app.page, allowLabel);
    if (!pending && !card) return false;
    const operation = pending?.approval?.operation;
    const command = operation?.command ?? card?.command;
    const tool = (card ? cardTool(card.title, locale, chat === "B" ? ["run_command"] : allowed[chat]) :
      operation?.tool ?? pending?.executable ?? "").replace(/^native:/u, "");
    if (chat === "B") {
      assert.equal(command, words.zip, "Unexpected command in the Zip approval");
      assert(!existsSync(join(demoRoot, "Desktop", words.zipName)), "Zip was created before approval");
      return true;
    }
    assert(allowed[chat].includes(tool), `Unexpected approval in chat ${chat}: ${tool || "unrecognized card tool"}`);
    if (tool === "run_command") assert.equal(command, words.organize, "Unexpected command in the Downloads approval");
    await click(app.page, allowLabel, `${approval} button`);
    if (pending) answered.add(pending.request_ref);
    return false;
  }, () => chatTimeout(app, chat, lastView), 120_000);
  return session.id;
}

async function applyPending(api: Api, words: Words) {
  const { pending } = await api<{ pending: { id: string; text?: string }[] }>("/memory/instructions/pending");
  for (const { id, text } of pending) {
    if (words.memory.some(rule => rule === text)) {
      await api(`/memory/instructions/pending/${encodeURIComponent(id)}`, "POST", { decision: "apply" });
    }
  }
}

function configure(data: string, locale: Locale, stub: Stub) {
  writeOnboardingComplete(data);
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    user: { language: locale.language },
    system: { defaultModel: demoModel.model_ref },
    models: { local: [{ ...demoModel, server_url: `http://127.0.0.1:${stub.port}` }] },
    metrics: { enabled: false },
  }));
}

async function setupWorkspace(app: App, locale: Locale, shots: Recorder) {
  const api = await app.ready();
  const now = new Date().toISOString();
  await api("/settings", "PATCH", {
    language: locale.language, appearance_theme: locale.theme, text_size: storeTextSize,
    ...onboardingCompletedPatch(undefined, now, now),
  });
  await api("/setup/butler-vault/decline", "POST");
  const settings = await api<{ access_mode: string }>("/settings");
  assert.equal(settings.access_mode, "ask_except_reads");
  let memorySetupFailure: unknown;
  if (shots.selected("06")) {
    try { await enableMemory(api, shots); }
    catch (error) { memorySetupFailure = error; }
  }
  await app.page.reload();
  await verifyTheme(app.page, locale);
  await verifyTextSize(app.page, storeScale * app.displayScale);
  await focus(app); // Play the chats at the 1920x1080 layout the shots use.
  return { api, memorySetupFailure };
}

async function enableMemory(api: Api, shots: Recorder) {
  await api("/personalization", "PATCH", { profiling: { mode: "basic" } });
  try {
    const reply = await api<{ memory_model?: MemoryProgress }>("/setup/memory-model", "POST", { enabled: true });
    shots.facts.memoryModel = reply.memory_model ?? null;
  } catch (error) {
    shots.facts.memoryModel = { state: "request_failed", error: redact(String(error)) };
    throw error;
  }
}

async function workspace(exe: string, out: string, locale: Locale, shots: Recorder, displayScale: number) {
  const words = demo(locale.language);
  const root = mkdtempSync(join(tmpdir(), "store-shots-workspace-"));
  const data = join(root, "data");
  let stub: Stub | undefined;
  let app: App | undefined;
  let setup: Awaited<ReturnType<typeof setupWorkspace>> | undefined;
  const sessions = new Map<Chat, string>();
  let setupFailure: unknown;
  let ownsDemo = false;
  const chatFailures = new Map<Chat, unknown>();
  try {
    try {
      stub = await startDemoStub(words, shots.facts.stubRequests);
      configure(data, locale, stub);
      mkdirSync(demoRoot); // Refuse to reuse an existing profile; delete only this run's fixture.
      ownsDemo = true;
      populateDemoFiles(locale.language);
      app = await startApp(exe, data, root, locale, out, "workspace", displayScale);
      setup = await setupWorkspace(app, locale, shots);
      const { api } = setup;
      for (const chat of chatOrder) {
        try {
          sessions.set(chat, await playChat(app, api, locale, words, stub, chat));
          if (chat === "D") await applyPending(api, words);
          if (chat === "A") assertOrganized(locale.language);
        } catch (error) { chatFailures.set(chat, error); }
      }
    } catch (error) { setupFailure = error; }
    await workspaceShots(shots, app, setup, locale, words, sessions, chatFailures, setupFailure);
  } finally {
    try { await app?.stop(); }
    finally {
      try { await stub?.stop(); }
      finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        if (ownsDemo) rmSync(demoRoot, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
}

async function workspaceShots(shots: Recorder, app: App | undefined,
  setup: Awaited<ReturnType<typeof setupWorkspace>> | undefined, locale: Locale,
  words: Words, sessions: Map<Chat, string>, chatFailures: Map<Chat, unknown>, setupFailure: unknown) {
  const take = (name: string, dependencies: readonly Chat[], prepare: (app: App, api: Api) => Promise<void>,
    beforePixels?: (app: App) => Promise<object>, onFailure?: (error: unknown) => Promise<unknown>) =>
    shots.shot(name, app, async () => {
      if (setupFailure) throw setupFailure;
      assert(app && setup, "Workspace setup did not finish");
      for (const chat of dependencies) if (chatFailures.has(chat)) throw chatFailures.get(chat);
      await prepare(app, setup.api);
      if (/^0[2-5]-/u.test(name)) await assertDesktopLayout(app.page, name === "04-browser");
    }, beforePixels, onFailure);
  await take("02-organize-files", ["A"], app => organized(app.page, words));
  await take("03-ask-first", ["B"], app => pendingZip(app.page, words, locale), app => assertModelChip(app.page, locale));
  await take("04-browser", ["C"], app => browserShot(app, words), app => assertBrowserStills(app.page, locale));
  await take("05-schedules", ["A"], async (app, api) => {
    const target = sessions.get("A");
    assert(target, "Downloads chat did not return a session ID");
    await createSchedules(api, locale.language, target);
    await schedulesShot(app.page, words, locale);
  });
  const diagnostics: MemoryDiagnostics = {};
  await take("06-memory", chatOrder, (app, api) => {
    if (setup?.memorySetupFailure) throw setup.memorySetupFailure;
    return prepareMemory(app, api, words, locale, shots.facts, diagnostics);
  }, app => frameMemory(app.page, words, locale),
    error => memoryTimeout(error, app, setup?.api, shots.facts, diagnostics));
}

async function captureFirstRun(exe: string, out: string, locale: Locale, shots: Recorder, displayScale: number) {
  const root = mkdtempSync(join(tmpdir(), "store-shots-setup-"));
  let app: App | undefined;
  let startupFailure: unknown;
  try {
    try { app = await startApp(exe, join(root, "data"), root, locale, out, "first run", displayScale); }
    catch (error) { startupFailure = error; }
    await shots.shot("01-ai-connect", app, async () => {
      if (startupFailure) throw startupFailure;
      assert(app);
      await firstRun(app, locale);
    });
  } finally {
    try { await app?.stop(); }
    catch (error) { shots.facts.errors.push(app ? app.safe(String(error)) : redact(String(error))); }
    finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      shots.save();
    }
  }
}

async function captureLocale(exe: string, out: string, locale: Locale, selected: ReadonlySet<string>, displayScale: number) {
  const shots = shotRecorder(out, locale, selected, displayScale);
  if (selected.has("01")) await captureFirstRun(exe, out, locale, shots, displayScale);
  try {
    if ([...selected].some(prefix => prefix !== "01")) await workspace(exe, out, locale, shots, displayScale);
  } catch (error) { shots.facts.errors.push(redact(String(error))); }
  finally { shots.save(); }
  for (const shot of shots.facts.shots) console.log(`${displayScale}x ${locale.locale} ${shot.name}: ${shot.error ? "FAILED (see facts.json)" : shot.method}`);
  return shots.facts.errors.length > 0 || shots.facts.shots.length !== selected.size ||
    shots.facts.shots.some(shot => Boolean(shot.error));
}

const [appDirectory, outputDirectory] = process.argv.slice(2);
assert(process.platform === "win32" && appDirectory && outputDirectory, "Usage on Windows: bun capture.ts <app-dir> <out-dir>");
const executable = resolve(appDirectory, "Butler.exe");
assert(existsSync(executable), "Butler.exe was not found");
const selected = new Set(readFileSync(join(import.meta.dir, "shots"), "utf8").split(/\r?\n/u).map(line => line.trim()).filter(Boolean));
assert([...selected].every(prefix => /^0[1-6]$/u.test(prefix)), "shots must list prefixes 01 through 06");
const displayScales = readFileSync(join(import.meta.dir, "display-scales"), "utf8")
  .split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(Number);
assert(displayScales.every(scale => Number.isFinite(scale) && scale >= 1 && scale <= 3),
  "display-scales must list finite numbers from 1 to 3");
let failed = false;
for (const displayScale of displayScales) {
  for (const locale of locales) {
    const out = resolve(outputDirectory, `${Math.round(displayScale * 100)}`, locale.locale);
    try { failed = await captureLocale(executable, out, locale, selected, displayScale) || failed; }
    catch {
      // Details written to the locale's artifacts are redacted before upload.
      console.error(`${displayScale}x ${locale.locale} capture did not finish. See the locale artifacts.`);
      failed = true;
    }
  }
}
process.exitCode = failed ? 1 : 0;
