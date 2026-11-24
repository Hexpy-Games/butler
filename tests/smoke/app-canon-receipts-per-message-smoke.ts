// test-category: race
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { createNativeAppServer, type StubModelRequest } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const messageA = "남은 일 과제로 등록해 줘";
const messageB = "상세페이지 과제도 추가해 줘";
const replyA = "A 등록 완료";
const replyB = "B 등록 완료";
const titlesA = Array.from({ length: 7 }, (_, index) => `과제 A${index + 1}`);
const titlesB = ["과제 B1"];
const assistantRows = '[data-test-class~="message"][data-test-class~="assistant"]';
const epicCards = '[data-test-class="chat-epic-cards"] [data-kanban-item]';

type StubMessage = { role: string; content: string | null };
function turn(request: StubModelRequest) {
  if (!request.stream || !Array.isArray(request.body.tools)) return;
  const messages = JSON.stringify(request.messages);
  if (messages.includes(messageB)) return "B";
  if (messages.includes(messageA)) return "A";
}

function boundEpicIds(request: StubModelRequest) {
  const result = (request.messages as StubMessage[]).findLast(message => message.role === "tool");
  const output = JSON.parse(result?.content ?? "{}") as { bound?: string[]; output?: { bound?: string[] } };
  return (output.output?.bound ?? output.bound ?? []).map(ref => ref.replace(/^canon:epic\//u, ""));
}

let projectId = "";
let idsA: string[] = [];
const rounds = { A: 0, B: 0 };
const server = await createNativeAppServer({
  uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
  config: { user: { language: "ko" } },
  stubReply: () => "",
  stubTextStream: async function* (request) {
    const current = turn(request);
    if (current === "B") await Bun.sleep(4_000);
    yield current === "A" ? replyA : current === "B" ? replyB : "";
  },
  stubToolCall: request => {
    const current = turn(request);
    if (!current) return null;
    const round = rounds[current]++;
    if (round === 0) return {
      name: "canon_propose",
      arguments: {
        project_id: projectId,
        summary: current === "A" ? "남은 일 등록" : "상세페이지 과제 추가",
        changes: (current === "A" ? titlesA : titlesB).map(title => ({ op: "epic.create", title })),
      },
    };
    if (current === "A" && round === 1) {
      idsA = boundEpicIds(request);
      return { name: "answer_blocks", arguments: { v: 2, blocks: [{ type: "epics", project_id: projectId, ids: idsA }] } };
    }
    return null;
  },
});

async function sampleTurnB(page: Page, rowA: Locator, rowB: Locator, sentAt: number) {
  const expected = JSON.stringify([...idsA].sort());
  const deadline = sentAt + 30_000;
  let mismatch: (string | null)[] | undefined;
  for (;;) {
    const finished = await rowB.isVisible();
    const ids = await rowA.evaluateAll(([row]) =>
      Array.from(row?.querySelectorAll("[data-kanban-item]") ?? [], card => card.getAttribute("data-kanban-item")).sort());
    if (JSON.stringify(ids) !== expected) mismatch ??= ids;
    if (finished) return mismatch;
    assert(performance.now() < deadline, "Step 4: B reply did not become visible");
    await page.waitForTimeout(100);
  }
}

async function exercise(page: Page) {
  const assistant = (reply: string) => page.locator(assistantRows).filter({ has: page.getByText(reply, { exact: true }) });
  const cardTitles = async (reply: string) => {
    const cards = assistant(reply).locator(epicCards);
    const titles = await cards.locator('[data-test-class="canon-epic-title"]').allTextContents();
    return titles.sort();
  };
  const expectA = titlesA;
  const expectB = titlesB;
  const send = async (text: string) => {
    await page.locator('[contenteditable="true"]').fill(text);
    await page.getByRole("button", { name: "전송", exact: true }).click();
  };

  await page.goto(server.url);
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await send(messageA);
  await assistant(replyA).waitFor();
  console.log("Step 2 PASS: A reply");

  await assistant(replyA).getByText(titlesA[6], { exact: true }).waitFor();
  assert.deepEqual(await cardTitles(replyA), expectA, "Step 3: A cards");
  console.log("Step 3 PASS: A has 7 cards");

  await page.locator('[contenteditable="true"]').fill(messageB);
  const sentAt = performance.now();
  const sendB = page.getByRole("button", { name: "전송", exact: true }).click();
  const [, mismatch] = await Promise.all([sendB, sampleTurnB(page, assistant(replyA), assistant(replyB), sentAt)]);
  assert.equal(mismatch, undefined, `Step 4: A must keep exactly its seven epic IDs throughout turn B (${JSON.stringify(mismatch)})`);
  console.log("Step 4 PASS: B reply");

  await assistant(replyB).getByText(titlesB[0], { exact: true }).waitFor();
  assert.deepEqual(await Promise.all([cardTitles(replyA), cardTitles(replyB)]), [expectA, expectB], "Step 5: live cards by reply");
  console.log("Step 5 PASS: A has 7 cards and B has 1");

  await page.reload();
  await Promise.all([
    assistant(replyA).getByText(titlesA[6], { exact: true }).waitFor(),
    assistant(replyB).getByText(titlesB[0], { exact: true }).waitFor(),
  ]);
  assert.deepEqual(await Promise.all([cardTitles(replyA), cardTitles(replyB)]), [expectA, expectB], "Step 6: reloaded cards by reply");
  console.log("Step 6 PASS: A has 7 cards and B has 1 after reopening");
}

let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const { project } = await server.api<{ project: { id: string } }>("/projects", {
    method: "POST", body: JSON.stringify({ source: "scratch", display_name: "과제 등록" }),
  });
  projectId = project.id;
  console.log("Step 1 PASS: full access, Korean, scratch project");
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  await server.signIn(context);
  await exercise(await context.newPage());
} finally {
  try { await browser?.close(); } finally { await server.stop(); }
}
