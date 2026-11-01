// test-category: security
// Adding a project whose folder has hooks asks about it once, in the real app with a real Agent.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(output, "Set BUTLER_SMOKE_SCREENSHOTS to a temporary screenshot directory");
mkdirSync(output, { recursive: true });

const labels = {
  ko: { sidebar: "사이드바 보기", menu: "스페이스 메뉴", project: "새 프로젝트", choose: "폴더 선택", use: "이 폴더 사용", create: "만들기",
    title: "이 폴더의 훅을 실행할까요?", deny: "실행 안 함", allow: "실행", receives: "프롬프트와 도구 결과를 받고, 출력이 모델에 전달될 수 있습니다" },
  en: { sidebar: "Show sidebar", menu: "Space menu", project: "New project", choose: "Choose folder", use: "Use this folder", create: "Create",
    title: "Run this folder's hooks?", deny: "Don't run", allow: "Run", receives: "Receives your prompts and tool results; output can reach the model" },
};
type Language = keyof typeof labels;

const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const settings = await server.api<{ default_project_workspace_path: string }>("/settings");
const workspaceRoot = settings.default_project_workspace_path;
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
const page = await context.newPage();
await server.signIn(page);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

const hook = (id: string, event: string, command: string, tools?: string[]) =>
  ({ id, event, type: "command", command, ...(tools ? { match: { tools } } : {}) });
const short = [
  hook("setup", "SessionStart", "./scripts/hooks/setup-env.sh"),
  hook("guard", "PreToolUse", "./scripts/hooks/guard.sh --strict", ["run_command"]),
  hook("lint", "Stop", "bun run lint"),
];
const long = [
  ...short,
  hook("context", "UserPromptSubmit", "./scripts/hooks/prompt-context.sh"),
  hook("format", "PostToolUse", "bunx prettier --write \"$TOOL_PATH\"", ["write_file", "edit_file"]),
  hook("report", "PostToolUse", "LOG_LEVEL=debug ./scripts/hooks/after-edit.sh --report build/hook-report.json --fail-on-warning", ["edit_file"]),
  hook("multi", "Stop", "./scripts/hooks/summary.sh\n./scripts/hooks/notify.sh"),
  ...Array.from({ length: 13 }, (_, index) => hook(`post-${index}`, "PostToolUse", `./scripts/hooks/check-${index + 1}.sh`, ["run_command"])),
  ...Array.from({ length: 12 }, (_, index) => hook(`pre-${index}`, "PreToolUse", `./scripts/hooks/before-${index + 1}.sh`, ["read_file"])),
];

let folders = 0;
function folder(hooks?: unknown[] | string): string {
  const name = `trust-${++folders}`;
  const root = join(workspaceRoot, name);
  mkdirSync(join(root, ".butler"), { recursive: true });
  if (hooks) writeFileSync(join(root, ".butler/hooks.json"), typeof hooks === "string" ? hooks : JSON.stringify({ version: 1, hooks }));
  return name;
}

async function settle(target: Page) {
  await target.evaluate(() => document.fonts.ready);
  await target.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
}

async function home(language: Language, theme: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
  await page.goto(server.url);
  await page.locator('[data-test-class="composer-card"]').waitFor();
}

/** Fills the real project dialog with `name`, up to its create button. */
async function fill(language: Language, name: string) {
  const copy = labels[language];
  const sidebar = page.getByRole("button", { name: copy.sidebar, exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole("button", { name: copy.menu, exact: true }).click();
  await page.getByRole("menuitem", { name: copy.project, exact: true }).click();
  await page.getByRole("button", { name: copy.choose, exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: copy.use, exact: true }).click();
  await page.getByRole("button", { name: copy.create, exact: true }).waitFor();
}

async function add(language: Language, name: string) {
  await fill(language, name);
  await page.getByRole("button", { name: labels[language].create, exact: true }).click();
}

const asked = () => page.getByRole("alertdialog");

async function question(name: string): Promise<{ folder: string; hooks: unknown[] } | null> {
  const { projects } = await server.api<{ projects: { id: string; display_name: string }[] }>("/projects");
  const project = projects.find((candidate) => candidate.display_name === name);
  assert(project, name);
  return (await server.api<{ question: { folder: string; hooks: unknown[] } | null }>(`/projects/${project.id}/folder-trust`)).question;
}

/** The chat opened, in the composer of a new project chat. */
async function chatOpened() {
  await asked().waitFor({ state: "hidden" });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator('[data-test-class="composer-card"]').waitFor();
}

/** Clicks an answer and waits until the Agent has it. */
async function answer(label: string) {
  const posted = page.waitForResponse((response) =>
    response.url().endsWith("/folder-trust") && response.request().method() === "POST");
  await asked().getByRole("button", { name: label, exact: true }).click();
  assert.equal((await posted).status(), 200);
}

async function shot(name: string, target = asked()) {
  await page.mouse.move(0, 0);
  await settle(page);
  const box = (await target.boundingBox())!;
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - 16);
  const y = Math.max(0, box.y - 16);
  await page.screenshot({ path: join(output!, `${name}.png`),
    clip: { x, y, width: Math.min(viewport.width - x, box.width + 32), height: Math.min(viewport.height - y, box.height + 32) } });
}

async function exercise() {
  await home("ko", "light", 1280);
  const copy = labels.ko;

  // The dialog says what the card says, with every hook within reach and the buttons on screen.
  const everything = folder(long);
  await add("ko", everything);
  await asked().waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0, "the project dialog closed first");
  await asked().getByRole("heading", { name: copy.title, exact: true }).waitFor();
  await asked().getByText(copy.receives, { exact: true }).waitFor();
  const text = await asked().innerText();
  assert(text.includes(join(workspaceRoot, everything)), text);
  assert(text.includes("PreToolUse (run_command) · ./scripts/hooks/guard.sh --strict"), text);
  assert(text.includes("./scripts/hooks/summary.sh⏎./scripts/hooks/notify.sh"), "a real line break is marked");
  // The path and every hook line sit in their own left-to-right isolate.
  assert.equal(await asked().locator('bdi[dir="ltr"]').count(), long.length + 1);
  const buttons = asked().getByRole("button");
  assert.deepEqual(await buttons.allTextContents(), [copy.deny, copy.allow]);
  const denied = (await buttons.first().boundingBox())!;
  const allowed = (await buttons.last().boundingBox())!;
  assert(allowed.x > denied.x, "the primary comes last");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const last = asked().getByText("before-12.sh", { exact: false });
    await last.scrollIntoViewIfNeeded();
    assert(await last.isVisible(), "the last hook is reachable");
    const box = (await buttons.last().boundingBox())!;
    assert(box.y + box.height <= 700 && box.x + box.width <= width, `buttons stay on screen at ${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Closing it is no answer: the chat opens, and its first message asks.
  await page.keyboard.press("Escape");
  await chatOpened();
  assert((await question(everything))?.hooks.length === long.length, "closing saved nothing");
  await page.locator('[data-test-class="composer-card"]').getByRole("textbox").fill("안녕하세요");
  await page.locator("[data-test-class~='composer-send-button']").click();
  const card = page.locator('[data-test-class="composer-authority-decision"]').first();
  await card.getByText(copy.title, { exact: true }).waitFor();
  // Asked before Butler wrote anything: its own full-width row, not squeezed into the user's bubble.
  const composerWidth = (await page.locator('[data-test-class="composer-card"]').boundingBox())!.width;
  const cardWidth = (await card.boundingBox())!.width;
  assert(cardWidth >= composerWidth * 0.9, `card ${cardWidth}px beside composer ${composerWidth}px`);
  await card.getByRole("button", { name: copy.deny, exact: true }).click();
  await card.waitFor({ state: "hidden" });

  // Each answer is saved, and the chat opens.
  for (const label of [copy.deny, copy.allow]) {
    const name = folder(short);
    await add("ko", name);
    await answer(label);
    await chatOpened();
    assert.equal(await question(name), null, `${label} is on record`);
  }

  // A file that changed while asking saves nothing, and the first message takes it from there.
  const changed = folder(short);
  await add("ko", changed);
  await asked().waitFor();
  writeFileSync(join(workspaceRoot, changed, ".butler/hooks.json"),
    JSON.stringify({ version: 1, hooks: [hook("new", "Stop", "./other.sh")] }));
  await answer(copy.allow);
  await chatOpened();
  assert.equal(await asked().count(), 0);
  assert.equal((await question(changed))?.hooks.length, 1, "the changed file is still unanswered");

  // A chat that will open in full access says so.
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access" }) });
  for (const [device, width] of [["desktop", 1440], ["phone", 390]] as const) {
    await home("ko", "light", width);
    await add("ko", folder(short));
    await asked().getByText("샌드박스 없이 실행됩니다", { exact: true }).waitFor();
    await shot(`full-access-light-${device}-ko`);
    await page.keyboard.press("Escape");
    await chatOpened();
  }
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "ask_first" }) });
  await home("ko", "light", 1280);

  // Nothing to ask about shows nothing, as before.
  for (const hooks of [undefined, "{broken"]) {
    const name = folder(hooks);
    await add("ko", name);
    await chatOpened();
    assert.equal(await asked().count(), 0, "no question");
    assert.equal(await question(name), null);
  }
  console.log("Folder trust flow: closed, refused, trusted, changed, nothing to ask");
}

async function captures() {
  const taken: string[] = [];
  for (const [list, hooks] of [["short", short], ["long", long]] as const) {
    for (const theme of ["light", "dark"]) for (const [device, width] of [["desktop", 1440], ["phone", 390]] as const) {
      for (const language of ["ko", "en"] as const) {
        await home(language, theme, width);
        await add(language, folder(hooks));
        await asked().waitFor();
        const name = `${list}-${theme}-${device}-${language}`;
        await shot(name);
        taken.push(name);
        await page.keyboard.press("Escape");
        await chatOpened();
        if (list === "short") {
          // The same question on the first message's card.
          await page.locator('[data-test-class="composer-card"]').getByRole("textbox").fill("Hello");
          await page.locator("[data-test-class~='composer-send-button']").click();
          const card = page.locator('[data-test-class="composer-authority-decision"]').first();
          await card.getByText(labels[language].title, { exact: true }).waitFor();
          await shot(`card-${theme}-${device}-${language}`, card);
          taken.push(`card-${theme}-${device}-${language}`);
          await card.getByRole("button", { name: labels[language].deny, exact: true }).click();
          await card.waitFor({ state: "hidden" });
        }
      }
    }
  }
  for (const theme of ["light", "dark"]) for (const [device, width] of [["desktop", 1440], ["phone", 390]] as const) {
    await home("ko", theme, width);
    await fill("ko", folder());
    await shot(`no-hooks-${theme}-${device}-1-dialog`, page.getByRole("dialog"));
    await page.getByRole("button", { name: labels.ko.create, exact: true }).click();
    await chatOpened();
    await settle(page);
    await page.screenshot({ path: join(output!, `no-hooks-${theme}-${device}-2-chat.png`) });
    taken.push(`no-hooks-${theme}-${device}`);
  }
  console.log(`Captures: ${taken.length}`);
}

try {
  await exercise();
  if (process.env.BUTLER_FOLDER_TRUST_CAPTURES) await captures();
  assert.deepEqual(errors, []);
  console.log("PASS");
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
  await server.stop();
}
