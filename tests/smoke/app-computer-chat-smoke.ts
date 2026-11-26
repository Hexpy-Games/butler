import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { UserQuestion } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { appLocaleFromLanguage, getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { createNativeAppServer, type StubModelRequest } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const language = process.env.COMPUTER_CHAT_SMOKE_LANGUAGE ?? "ko";
const ko = language === "ko";
const copy = getAppCopy(appLocaleFromLanguage(language));
const buttons = copy.interfaceDetails.questionPanel;
const titles = ko
  ? ["컴퓨터 이름", "SSH 주소 (~/.ssh/config 별칭 사용 가능)", "작업 폴더", "그 컴퓨터에서 쓸 모델"]
  : ["Computer name", "SSH address (~/.ssh/config aliases work)", "Work folder", "Model for that computer"];
const follow = ko ? "이 기기와 같게" : "Same as this device";
const none = ko ? "설정 안 함" : "Not set";
const notice = ko ? "추가하면 이 기기의 모델 키가 그 컴퓨터로 전달됩니다" : "Adding it sends this device's model key to that computer.";
const options = [
  { id: "model:follow", label: follow, description: notice, recommended: true },
  { id: "model:chatgpt", label: "ChatGPT" },
  { id: "model:none", label: none },
];
const name = "작업실 iMac";
const input = "Help me add a computer.";
const laterInput = "Help me set up another computer.";
const continuation = "The setup card is ready.";
const screenshots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const variants = ko
  ? [["light", 1280], ["dark", 1280], ["light", 375], ["dark", 375]] as const
  : [["light", 1280]] as const;

const isConversation = (request: StubModelRequest) => request.stream && Array.isArray(request.body.tools)
  && request.body.tools.length > 0 && [input, laterInput].some(text => JSON.stringify(request.messages).includes(text));
let round = 0;
const server = await createNativeAppServer({
  uiRoot: process.env.BUTLER_SMOKE_UI_ROOT,
  config: { user: { name: "Smoke", language } },
  stubReply: request => isConversation(request) ? (++round === 1 ? "" : continuation) : "{}",
  stubToolCall: request => isConversation(request) && round === 1
    ? { name: "computer_add", arguments: { name, address: "studio", folder: "~/projects" } }
    : null,
});

const questionPanel = (page: Page) => page.locator('[data-slot="composer-question-panel"]');
const button = (scope: Page | Locator, label: string) => scope.getByRole("button", { name: label, exact: true });

async function send(page: Page, text: string) {
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill(text);
  await button(page, copy.composer.send).click();
}

async function capture(page: Page, number: string) {
  if (!screenshots) return;
  for (const [theme, width] of variants) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 1000 });
    await page.locator(`body.theme-${theme}`).waitFor();
    await page.screenshot({ path: join(screenshots, `${number}-${language}-${theme}-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

async function captureFixtures(page: Page, includeAddModel: boolean) {
  const eyebrow = ko ? "컴퓨터" : "Computer";
  const id = "10000000-0000-4000-8000-000000000001";
  const cards: ({ shot: string; id: string; title: string; options: { id: string; label: string; recommended?: boolean }[] }
    | { shot: string; id: string; questions: UserQuestion[] })[] = [
    {
      shot: "4", id: `computer_edit:${id}.model`, title: ko ? `${name}에서 쓸 모델` : `Model for ${name}`,
      options: options.map(({ description, ...option }) => option),
    },
    {
      shot: "7", id: `computer_remove:${id}.confirm`,
      title: ko ? `${name}을 삭제할까요? 그 컴퓨터에 올린 버틀러와 모델 설정을 지웁니다. 대화 기록은 남습니다.`
        : `Delete ${name}? This removes Butler and its model settings from that computer. Conversation history stays.`,
      options: [
        { id: "remove:keep", label: ko ? "삭제" : "Delete" },
        { id: "remove:forget", label: ko ? "삭제하고 이 컴퓨터 대화에서 나온 기억도 지우기" : "Delete and erase memories from conversations on this computer" },
      ],
    },
  ];
  if (includeAddModel) {
    cards.unshift({ shot: "6", id: "computer_add.model", title: titles[3]!, options });
  }
  const fields = [["port", ko ? "포트" : "Port"], ["key_file", ko ? "키 파일" : "Key file"]] as const;
  for (const [shot, code, reason] of [
    ["8", "ssh_auth_failed", ko ? "키로 로그인할 수 없습니다" : "Can't sign in with a key"],
    ["9", "ssh_unreachable", ko ? "연결할 수 없습니다" : "Can't connect"],
  ] as const) {
    const id = `computer_add:${code}`;
    cards.push({ shot, id, questions: fields.map(([field, label]) => ({
      id: `${id}.${field}`,
      eyebrow: label,
      title: ko ? `${reason}. ${name}의 ${label}` : `${reason}. ${label} for ${name}`,
      kind: "single",
      allow_custom: true,
      options: [
        ...(shot === "9" && field === "port" ? [{ id: "proposed", label: "2222", recommended: true, kind: "answer" as const }] : []),
        { id: "none", label: none, kind: "answer" },
      ],
    })) });
  }
  for (const card of cards) {
    const pattern = "**/session-view?*";
    await page.route(pattern, async route => {
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
      const body = await response.json();
      const view = body.data ?? body;
      const [request] = view.pending_questions;
      let questions: UserQuestion[];
      if ("questions" in card) {
        questions = card.questions;
      } else {
        const options = card.options.map(option => ({ ...option, kind: "answer" as const }));
        questions = card.id === "computer_add.model"
          ? request.questions.questions.map((question: UserQuestion) =>
            question.id === card.id ? { ...question, options } : question)
          : [{ id: card.id, eyebrow: card.id.endsWith(".model") ? (ko ? "모델" : "Model") : eyebrow,
            title: card.title, kind: "single", allow_custom: false, options }];
      }
      view.pending_questions = [{
        ...request, request_ref: card.id, question_state: "pending", questions: { questions },
      }];
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    const panel = questionPanel(page);
    if ("questions" in card) {
      for (const [index, question] of card.questions.entries()) {
        if (index > 0) await panel.getByRole("tab", { name: question.eyebrow, exact: true }).click();
        await panel.getByText(question.title, { exact: true }).waitFor();
        await capture(page, `${card.shot}${index === 0 ? "a" : "b"}`);
      }
    } else {
      if (card.id === "computer_add.model") {
        for (const title of titles.slice(0, 3)) {
          await panel.getByText(title, { exact: true }).waitFor();
          await button(panel, buttons.skip).click();
        }
      }
      await panel.getByText(card.title, { exact: true }).waitFor();
      await capture(page, card.shot);
    }
    await page.unroute(pattern);
  }
}

let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
  const { main_model } = await server.api<{ main_model: string }>("/computers", { headers: { "x-butler-admin": secret } });
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await server.signIn(page);
  await page.goto(server.url);
  await send(page, input);
  const panel = questionPanel(page);
  for (const [step, title] of titles.entries()) {
    await panel.getByText(title, { exact: true }).waitFor();
    if (step === 0) {
      assert.equal(await panel.getByRole("tab").count(), 5, "four steps and review");
      const status = page.locator('[data-test-class="turn-current-status-slot"]');
      await status.getByText(copy.interfaceStatus.answerWaiting, { exact: true }).waitFor();
      await page.locator('[data-test-class~="turn-activity-panel"]').getByText(copy.guided.tools.computer_add, { exact: true }).first().waitFor();
      await capture(page, "1");
      await capture(page, "2");
    }
    if (step === 3) {
      for (const label of [follow, "ChatGPT", none]) await panel.getByText(label, { exact: true }).waitFor();
      assert.equal(await panel.getByText(notice, { exact: true }).count() > 0, main_model === "key");
      if (main_model === "key") await capture(page, "6");
    }
    await button(panel, buttons.skip).click();
  }
  await button(panel, buttons.send).click();
  await page.getByText(continuation, { exact: true }).waitFor();
  console.log(`Computer chat smoke passed (${language}, main_model=${main_model})`);

  if (screenshots) {
    round = 0;
    await send(page, laterInput);
    await panel.getByText(titles[0]!, { exact: true }).waitFor();
    const later = button(panel, buttons.later);
    await later.click();
    await later.waitFor({ state: "hidden" });
    await panel.getByText(titles[0]!, { exact: true }).waitFor();
    await capture(page, "3");
    await captureFixtures(page, main_model !== "key");
  }
} finally {
  try { await browser?.close(); } finally { await server.stop(); }
}
