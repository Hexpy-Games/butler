import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Branch actions from a project-session answer against an isolated native
// gateway (temp BUTLER_DATA, free port, stub model): "Start a new
// conversation" creates a session in the same project and "Start a new
// project" creates a project, both seeded from the clicked answer.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import type {
  MessageRecord,
  NavigationView,
  ProjectSummary,
  SessionSummary,
  SessionView,
} from "../../packages/butler-app/client/ui/src/app/types.ts";
import {
  LEGACY_FIRST_RUN_STORAGE_KEY as FIRST_RUN_STORAGE_KEY,
  legacyFirstRunCompleteRecord,
} from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";

type BranchSeed = { sourceSessionId?: string; sourceMessageId?: string };

const dir = mkdtempSync(join(tmpdir(), "butler-branch-actions-"));
const server = await createNativeAppServer({
  butlerData: join(dir, "data"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"),
  config: { user: { name: "Smoke", language: "en" } },
  stubReply: () => "Here is the answer to branch from.",
});
const navigation = () => server.api<NavigationView>("/navigation");
const sessionView = (id: string) =>
  server.api<SessionView & { branch_seed?: BranchSeed }>(`/session-view?session_id=${encodeURIComponent(id)}`);

async function eventually<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function openSession(page: Page, projectId: string, sessionId: string): Promise<void> {
  // Expand the project only when it is collapsed: clicking an expanded
  // project header collapses it.
  const project = page.locator(`[data-tree-item="p:${projectId}"]`);
  await project.waitFor();
  const toggle = project.locator("[aria-expanded]").first();
  await toggle.waitFor();
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  const row = page.locator(`[data-tree-item="s:${sessionId}"] [data-test-class~="tree-row"]`);
  await row.click();
  await page.locator('[data-test-class~="assistant-footer"]').first().waitFor();
}

async function branchFromAnswer(page: Page, action: string, title: string): Promise<void> {
  const footer = page.locator('[data-test-class~="assistant-footer"]').last();
  await footer.hover();
  await footer.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#branch-title").fill(title);
  await dialog.locator('button[type="submit"]').click();
  await dialog.waitFor({ state: "detached", timeout: 60_000 });
}

function assertSeededFrom(view: { branch_seed?: BranchSeed }, sourceId: string, answer: MessageRecord): void {
  assert.equal(view.branch_seed?.sourceSessionId, sourceId, "branch seed names the project session as its source");
  assert.equal(view.branch_seed?.sourceMessageId, answer.id, "branch seed names the clicked answer");
}

const browser = await launchSmokeBrowser();
try {
  const project = (await server.api<{ project: ProjectSummary }>("/projects", {
    method: "POST", body: JSON.stringify({ source: "scratch", display_name: "Branch source project" }),
  })).project;
  const source = (await server.api<{ session: SessionSummary }>("/sessions", {
    method: "POST", body: JSON.stringify({ kind: "project", project_id: project.id, title: "Source conversation" }),
  })).session;
  await server.api("/messages", {
    method: "POST",
    body: JSON.stringify({ chat_id: source.id, text: "Give me an answer.", client_message_id: `client-${crypto.randomUUID()}` }),
  });
  const answer = await eventually("the delivered project answer", async () =>
    (await sessionView(source.id)).messages.find((message) =>
      message.role === "assistant" && message.status === "delivered"));

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await server.signIn(page);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.goto(server.url);
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  await sidebar.waitFor();
  if (await sidebar.getAttribute("data-collapsed") === "true") {
    await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
  }

  // New conversation from the project answer: a session in the same project.
  await openSession(page, project.id, source.id);
  await branchFromAnswer(page, appCopy.interfaceStatus.branchChat, "Topic branch");
  const topic = await eventually("the topic branch session", async () =>
    (await navigation()).projects.find((item) => item.id === project.id)?.sessions
      ?.find((session) => session.title === "Topic branch"));
  assertSeededFrom(await sessionView(topic.id), source.id, answer);

  // New project from the same answer: a new project whose session is seeded from it.
  await openSession(page, project.id, source.id);
  await branchFromAnswer(page, appCopy.interfaceStatus.branchProject, "Branch project");
  const created = await eventually("the branch project", async () =>
    (await navigation()).projects.find((item) => item.display_name === "Branch project" && item.id !== project.id));
  const createdSession = created.sessions?.[0];
  assert(createdSession, "the new project has the branch session");
  assertSeededFrom(await sessionView(createdSession.id), source.id, answer);

  console.log(JSON.stringify({
    ok: true,
    service: "butler-app-branch-actions-smoke",
    checks: ["project-answer-new-conversation-same-project", "project-answer-new-project", "branch-seed-source"],
  }));
} finally {
  await browser.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
