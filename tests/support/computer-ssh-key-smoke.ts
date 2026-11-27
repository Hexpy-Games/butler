// Captures the SSH key setup screens: add dialog sign-in choice, the chat retry card with
// "set up with password", its password sheet, the card offered again, and the delete toast.
// The gateway and stub model are real; /computers* is the computers fake.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { computerFixtures, createComputersFake } from "./computers-fixtures.ts";
import { createNativeAppServer, type NativeAppServerHandle, type StubModelRequest } from "./native-app-server.ts";

type Locale = "ko" | "en";
const TRIGGER = "Add the studio computer.";
const card = {
  ko: { name: "작업실 iMac", reasons: ["키로 로그인할 수 없습니다", "비밀번호가 맞지 않습니다"], labels: ["포트", "키 파일"], none: "설정 안 함",
    title: (reason: string, name: string, label: string) => `${reason}. ${name}의 ${label}` },
  en: { name: "Studio iMac", reasons: ["Can't sign in with a key", "Wrong password"], labels: ["Port", "Key file"], none: "Not set",
    title: (reason: string, name: string, label: string) => `${reason}. ${label} for ${name}` },
} as const;

/** The retry card the computer tool builds (card.rs `connection`), sent through ask_user by the stub model. */
function retryCard(locale: Locale, attempt: number) {
  const c = card[locale];
  const reason = c.reasons[Math.min(attempt, 1)]!;
  const proposals = ["2222", "~/.ssh/id_ed25519"];
  return { questions: ["port", "key_file"].map((id, index) => ({
    id, eyebrow: c.labels[index], title: c.title(reason, c.name, c.labels[index]!), kind: "single", allow_custom: true,
    options: [
      { id: "proposed", label: proposals[index], recommended: true, kind: "answer" },
      ...(id === "key_file" ? [{ id: "password_setup", label: appCopy.computers.passwordSheet.title, description: c.name, kind: "answer" }] : []),
      { id: "none", label: c.none, kind: "answer" },
    ],
  })) };
}

const toolOutputs = (request: StubModelRequest) => request.messages.filter((m) => (m as { role?: string }).role === "tool").length;
const isCardTurn = (request: StubModelRequest) => request.stream && Array.isArray(request.body.tools) &&
  request.body.tools.length > 0 && JSON.stringify(request.messages).includes(TRIGGER);

/** The installed gateway drops option kinds other than `answer`; tag the card's option as the computer tool will. */
function tagPasswordSetup(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(tagPasswordSetup); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.id === "password_setup" && typeof record.label === "string") record.kind = "password_setup";
  Object.values(record).forEach(tagPasswordSetup);
}

/** Gateway notices (new device, background rounds) are not part of these screens. */
async function dismissToasts(page: Page) {
  await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-sonner-toaster]").forEach((node) => { node.style.visibility = "hidden"; }));
}

async function settle(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}

export async function captureSshKeySetup(browser: Browser, output: string, options: { before?: boolean; uiRoot?: string } = {}) {
  mkdirSync(output, { recursive: true });
  let captures = 0;
  for (const locale of ["ko", "en"] as const) {
    setAppCopyLanguage(locale);
    const fake = createComputersFake();
    const server = await createNativeAppServer({
      uiRoot: options.uiRoot ?? resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: locale } },
      stubReply: (request) => isCardTurn(request) ? "" : "{}",
      stubToolCall: (request) => isCardTurn(request) && toolOutputs(request) < 2
        ? { name: "ask_user", arguments: retryCard(locale, toolOutputs(request)) } : null,
    });
    try {
      for (const theme of ["light", "dark"] as const) {
        await server.api("/settings", { method: "PATCH", headers: adminHeaders(server), body: JSON.stringify({ appearance_theme: theme }) });
        for (const [size, width] of [["desktop", 1280], ["mobile", 375]] as const) {
          const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width, height: 1000 } });
          try {
            const page = await context.newPage();
            await server.signIn(page);
            await configure(page, server, fake);
            const shot = async (state: string, target: Locator, reveal?: Locator, margin = 0) => {
              if (state !== "S9") await dismissToasts(page);
              await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
              await reveal?.scrollIntoViewIfNeeded({ timeout: 10_000 });
              await settle(page);
              const path = join(output, `${state}-${locale}-${theme}-${size}.png`);
              const box = margin ? await target.boundingBox() : null;
              if (box) {
                const clip = { x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + margin * 2, height: box.height + margin * 2 };
                await page.screenshot({ path, clip, animations: "disabled", timeout: 10_000 });
              } else {
                await target.screenshot({ path, animations: "disabled", timeout: 10_000 });
              }
              console.log(path);
              captures++;
            };
            await addDialogStates(page, server.url, fake, shot, Boolean(options.before));
            await cardStates(page, server.url, locale, shot, Boolean(options.before));
            if (size === "desktop" && !options.before) await deleteToast(page, server, fake, shot);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await server.stop();
    }
  }
  return captures;
}

type Shot = (state: string, target: Locator, reveal?: Locator, margin?: number) => Promise<void>;
type Fake = ReturnType<typeof createComputersFake>;

function adminHeaders(server: NativeAppServerHandle) {
  const secret = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret as string;
  return { ...server.authHeaders, "x-butler-admin": secret };
}

async function configure(page: Page, server: NativeAppServerHandle, fake: Fake) {
  await page.route(`${server.url}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname.startsWith("/computers") || (method === "GET" && url.pathname === "/credentials")) {
      await route.fulfill(await fake.respond({ method, path: url.pathname + url.search, body: request.postDataJSON() }));
      return;
    }
    const admin = url.pathname.startsWith("/security") || url.pathname === "/settings";
    const headers = { ...request.headers(), ...(admin ? adminHeaders(server) : server.authHeaders) };
    if (method === "GET" && url.pathname === "/session-view") {
      const response = await route.fetch({ headers });
      const json = await response.json();
      tagPasswordSetup(json);
      await route.fulfill({ response, json });
      return;
    }
    await route.continue({ headers });
  });
}

async function openComputers(page: Page, url: string) {
  await page.goto(`${url}?settings=computers`, { waitUntil: "domcontentloaded" });
  const section = page.locator('[data-settings-section-id="computers"]');
  await section.getByText(appCopy.computers.empty, { exact: true }).or(section.locator('[data-test-class="computer-row"]').first()).waitFor();
  return section;
}

async function addDialogStates(page: Page, url: string, fake: Fake, shot: Shot, before: boolean) {
  const copy = appCopy.computers;
  fake.computers = [];
  const section = await openComputers(page, url);
  await section.getByRole("button", { name: copy.add, exact: true }).click();
  const dialog = page.locator('[data-test-class="computer-add-dialog"]');
  await dialog.locator("#computer-name").fill(copy.form.namePlaceholder);
  await dialog.locator("#computer-address").fill(copy.form.addressPlaceholder);
  await dialog.locator("#computer-folder").fill(copy.form.folderPlaceholder);
  if (before) { await shot("S1-before", dialog); return; }
  const password = dialog.locator("#computer-password");
  await password.fill("example-password");
  await shot("S1", dialog);
  await dialog.getByRole("radio", { name: copy.form.authKeyFile, exact: true }).click();
  await dialog.locator("#computer-key-file").fill(copy.form.keyFilePlaceholder);
  await shot("S2", dialog);
  await dialog.getByRole("radio", { name: copy.form.authPassword, exact: true }).click();
  await password.fill("example-password");
  const submit = dialog.locator('button[type="submit"]');
  let release!: () => void;
  fake.addHold = new Promise<void>((done) => { release = done; });
  try {
    await submit.click();
    const status = dialog.getByRole("status");
    await status.getByText(copy.form.installingKey, { exact: true }).waitFor();
    await shot("S3", dialog, status);
  } finally {
    release();
    fake.addHold = undefined;
  }
  await dialog.waitFor({ state: "hidden" });
  fake.computers = [];
  await openComputers(page, url);
  await section.getByRole("button", { name: copy.add, exact: true }).click();
  await dialog.locator("#computer-name").fill(copy.form.namePlaceholder);
  await dialog.locator("#computer-address").fill(copy.form.addressPlaceholder);
  await dialog.locator("#computer-folder").fill(copy.form.folderPlaceholder);
  for (const [state, code, message] of [
    ["S4", "ssh_password_wrong", copy.errors.passwordWrong],
    ["S5", "ssh_password_not_allowed", copy.errors.passwordNotAllowed],
  ] as const) {
    await password.fill("example-password");
    fake.failNext("add", code);
    await submit.click();
    await dialog.locator("[data-settings-field]:has(#computer-password)").getByText(message, { exact: true }).waitFor();
    assert.equal(await password.inputValue(), "", "password cleared once the call settles");
    await shot(state, dialog);
  }
  await dialog.getByRole("button", { name: appCopy.common.cancel, exact: true }).click();
}

async function cardStates(page: Page, url: string, locale: Locale, shot: Shot, before: boolean) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill(TRIGGER);
  await page.getByRole("button", { name: appCopy.composer.send, exact: true }).click();
  const panel = page.locator('[data-slot="composer-question-panel"]');
  const c = card[locale];
  await panel.getByText(c.title(c.reasons[0], c.name, c.labels[0]), { exact: true }).waitFor();
  await panel.getByText("2222", { exact: true }).click();
  await panel.getByText(c.title(c.reasons[0], c.name, c.labels[1]), { exact: true }).waitFor();
  if (before) { await shot("S6-before", panel); return; }
  await shot("S6", panel);
  await panel.getByText(appCopy.computers.passwordSheet.title, { exact: true }).click();
  await panel.getByRole("button", { name: appCopy.interfaceDetails.questionPanel.send, exact: true }).click();
  const sheet = page.locator('[data-test-class="computer-password-sheet"]');
  await sheet.waitFor();
  await sheet.locator('input[type="password"]').fill("example-password");
  await shot("S7", sheet);
  await sheet.getByRole("button", { name: appCopy.computers.passwordSheet.submit, exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
  await panel.getByText(c.title(c.reasons[1], c.name, c.labels[0]), { exact: true }).waitFor();
  await panel.getByText("2222", { exact: true }).click();
  await panel.getByText(c.title(c.reasons[1], c.name, c.labels[1]), { exact: true }).waitFor();
  await shot("S8", panel);
}

async function deleteToast(page: Page, server: NativeAppServerHandle, fake: Fake, shot: Shot) {
  const copy = appCopy.computers;
  fake.computers = computerFixtures.map((computer) => ({ ...computer }));
  fake.keyRemoved = false;
  try {
    const section = await openComputers(page, server.url);
    const [connected] = computerFixtures;
    const row = section.locator('[data-test-class="computer-row"]').filter({ hasText: connected!.name });
    await row.getByRole("button", { name: copy.removeComputer(connected!.name), exact: true }).click();
    const dialog = page.locator('[data-test-class="computer-delete-dialog"]');
    await dialog.getByRole("button", { name: copy.removeDialog.confirm, exact: true }).click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: copy.removeDialog.keyNotRemoved(connected!.name) });
    await toast.waitFor();
    await page.waitForTimeout(600);
    await shot("S9", toast, undefined, 16);
  } finally {
    fake.keyRemoved = undefined;
  }
}
