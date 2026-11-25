import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Browser, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { computerFixtures } from "./computers-fixtures.ts";
import { createNativeAppServer, type NativeAppServerHandle } from "./native-app-server.ts";

const fixtures = [
  { file: "removed-computer-transfer.ndjson", title: "지난 대화", question: "작업 폴더를 확인해 주세요.", answer: "작업 폴더를 확인했습니다.", tools: false },
  { file: "removed-computer-transfer-tools.ndjson", title: "작업 기록", question: "Complete the file update.", answer: "Checked.", tools: true },
];
const output = "/tmp/removed-computer-screens";

// The browser and main gateway are real. Replay the other machine at the SSH
// boundary so DELETE performs its final pull through computer_import_turn.
const ssh = String.raw`#!/bin/sh
set -eu
for command do :; done
case "$command" in
  'test -x '*)
    ;;
  'sh -s -- '*)
    cat >/dev/null
    version=$(printf "%s" "$command" | cut -d "'" -f 2)
    printf 'state=ready version=%s\n' "$version"
    ;;
  'sh -s')
    cat >/dev/null
    ;;
  *"--remote-request "*"'POST' '/remote/sessions'")
    cat >/dev/null
    printf '%s\n' '{"status":201,"body":{"data":{}}}'
    ;;
  *"--remote-request "*"'POST' '/remote/unlock'")
    cat >/dev/null
    printf '%s\n' '{"status":204,"body":null}'
    ;;
  *"--remote-request "*"'GET' '/remote/sessions/state'")
    printf '%s\n' '{"status":200,"body":{"data":{"sessions":[]}}}'
    ;;
  *"--remote-stream "*"'/remote/transcripts'")
    printf '%s\n' '{"status":200,"headers":{"content-type":"application/x-ndjson"}}'
    cat "$(dirname "$0")/transcripts.ndjson"
    ;;
  *)
    exit 1
    ;;
esac
`;

export async function captureRemovedComputer(browser: Browser, language: string) {
  const scratch = mkdtempSync(join(tmpdir(), "butler-removed-computer-"));
  const data = join(scratch, "data");
  const computer = { ...computerFixtures[0]!, arch: "x64", host_keys: [] };
  const release = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const version = new URL(request.url).pathname.match(/^\/v([^/]+)\/agent-update-manifest\.json$/u)?.[1];
      assert(version);
      return Response.json({ artifacts: [{
        version, platform: "linux-x64", artifact_url: new URL("/unused", request.url).href, sha256: "0".repeat(64),
      }] });
    },
  });
  let server: NativeAppServerHandle | undefined;
  try {
    mkdirSync(join(data, "config"), { recursive: true });
    writeFileSync(join(data, "config/computers.json"), JSON.stringify({ version: 1, computers: [computer] }));
    writeFileSync(join(scratch, "ssh"), ssh, { mode: 0o700 });
    server = await createNativeAppServer({
      butlerData: data,
      config: { user: { name: "Smoke", language } },
      env: {
        PATH: [scratch, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
        BUTLER_REMOTE_RELEASE_BASE: release.url.origin,
        BUTLER_SECRET_STORE: "file",
      },
    });
    const secret: string = JSON.parse(readFileSync(join(data, "app/runtime/auth/local-admin.json"), "utf8")).secret;
    const headers = { "x-butler-admin": secret };
    const turns: string[] = [];
    let end = "";
    for (const { file, title } of fixtures) {
      const { session } = await server.api<{ session: { session_hint: string } }>("/sessions", {
        method: "POST", body: JSON.stringify({ kind: "chat", title, computer_id: computer.id }),
      });
      const [line, cursor] = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8").trimEnd().split("\n");
      const turn = JSON.parse(line!);
      // The main allocates the remote session id when it creates the chat.
      turn.external_session_id = session.session_hint;
      turns.push(JSON.stringify(turn));
      end = cursor!;
    }
    writeFileSync(join(scratch, "transcripts.ndjson"), `${turns.join("\n")}\n${end}\n`);
    const removed = await server.api(`/computers/${computer.id}`, { method: "DELETE", headers });
    assert.deepEqual(removed, { deleted: true, remote_cleaned: true });
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    mkdirSync(output, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await server.api("/settings", { method: "PATCH", headers, body: JSON.stringify({ appearance_theme: theme }) });
      for (const [width, height] of [[1280, 900], [375, 812]] as const) {
        for (const fixture of fixtures) {
          const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
          try {
            await server.signIn(page);
            await page.goto(server.url);
            await captureConversation(page, copy, theme, width, fixture);
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    try { await server?.stop(); } finally {
      release.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

async function captureConversation(
  page: Page, copy: ReturnType<typeof getAppCopy>, theme: string, width: number,
  { title, question, answer, tools }: (typeof fixtures)[number],
) {
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const shot = async (name: string) => {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const path = join(output, `${name}-${theme}-${width}.png`);
    await page.screenshot({ path, animations: "disabled" });
    console.log(path);
  };
  const showSidebar = button(copy.titlebar.showLeftPanel);
  if (width === 375) await showSidebar.click();
  const row = page.locator('[data-test-class="tree-row"]').filter({ hasText: title });
  await row.getByText(copy.computers.removedComputer, { exact: true }).waitFor();
  if (!tools) await shot("R1-list-after-delete");
  const [response] = await Promise.all([
    page.waitForResponse((reply) => new URL(reply.url()).pathname === "/session-view"),
    row.click(),
  ]);
  assert(response.ok(), `Removed session view returned ${response.status()}`);
  const { data } = await response.json();
  assert.deepEqual(data.messages.map((message: { text: string }) => message.text), [question, answer]);
  assert.equal(data.latest_turn.state, "delivered");
  await page.getByText(question, { exact: true }).waitFor();
  await page.getByText(answer, { exact: true }).waitFor();
  const send = button(copy.composer.send);
  assert(await send.isDisabled());
  assert.equal(await page.locator("[data-test-class='attachment-button']").count(), 0);
  assert.equal(await page.locator('[data-test-class="composer-toolbar-spacer"]').count(), 0);
  await send.hover();
  await page.getByRole("tooltip").getByText(copy.computers.removedComputerSend, { exact: true }).waitFor();
  await page.mouse.move(0, 0);
  await page.getByRole("tooltip").waitFor({ state: "hidden" });

  const preview = page.locator("[data-slot='composer-compact-preview']");
  assert.equal(await preview.textContent(), copy.computers.removedComputerSend);
  if (tools) {
    await page.locator('[data-test-class="toggle-turn-activity-disclosure"]').click();
    await page.locator('[data-test-class~="turn-work-tool-group"] > button').click();
    assert.equal(await page.locator('[data-test-class="turn-work-tool-detail-row"]').count(), 2);
  }
  await shot(tools ? "R2-removed-conversation-tools" : "R2-removed-conversation");

  if (await preview.isVisible()) await preview.click();
  await page.locator("[data-expanded='true'] [data-slot='composer-expanded-body']")
    .getByText(copy.computers.removedComputerSend, { exact: true }).waitFor();
}
