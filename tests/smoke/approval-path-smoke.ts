// Offline approval-card harness: exact outside paths and visual-only ellipses.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser";

const output = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(output, "BUTLER_BROWSER_EVIDENCE required");
mkdirSync(output, { recursive: true });
const stage = process.env.BUTLER_APPROVAL_PATH_STAGE ?? "after";
const root = resolve(process.env.BUTLER_SMOKE_RENDERER_DIST ?? "packages/butler-app/client/ui/dist");
const outside = "/home/mina/Documents/reports/2026/customer-research/quarterly-review/approval-results.txt";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await launchSmokeBrowser();
let checked = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.addInitScript(({ outside }) => {
    const kind = new URLSearchParams(window.location.search).get("kind")!;
    const command = kind.includes("command");
    const dataRoot = kind.startsWith("root");
    (window as Window & { butlerApprovalFixture?: unknown }).butlerApprovalFixture = {
      action_kind: command ? "run_command" : "edit_files", count: 1, risk: "high",
      targets: [{ kind: "folder", path: "/home/mina/.butler" },
        ...(dataRoot ? [] : [{ kind: "outside", path: outside }])],
      examples: command ? ["pwd"] : [dataRoot ? "notes.txt" : outside],
    };
  }, { outside });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    for (const lang of ["ko", "en"]) for (const kind of ["file", "command", "root-file", "root-command"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&approval=1&state=completed&theme=${theme}&lang=${lang}&kind=${kind}`);
      const card = page.locator('[data-test-class="composer-authority-decision"]');
      await card.waitFor();
      if (stage === "after" && kind.startsWith("root")) {
        assert.ok((await card.innerText()).includes("'/home/mina/.butler'"));
      } else if (stage === "after") {
        const path = card.locator('[data-slot="composer-decision-details"] [title]').filter({ hasText: "approval-results.txt" });
        assert.equal(await path.first().getAttribute("title"), outside);
        assert.ok((await path.first().innerText()).includes("…"));
        assert.ok(!(await card.innerText()).includes("'.butler'"));
        const subject = await card.locator('[data-slot="composer-decision-subject"]').boundingBox();
        const actions = await card.locator('[data-slot="composer-decision-actions"]').boundingBox();
        assert.ok(subject && actions && subject.y + subject.height <= actions.y, "label above controls");
        assert.ok(await path.first().evaluate(node => {
          const box = node.getBoundingClientRect();
          const card = node.closest('[data-test-class="composer-authority-decision"]')!.getBoundingClientRect();
          return box.left >= card.left && box.right <= card.right && node.scrollWidth <= node.clientWidth;
        }), "path fits within card insets");
      }
      await page.screenshot({ path: join(output, `${stage}-${lang}-${kind}-${theme}-${width}.png`) });
      checked++;
    }
  }
  console.log(JSON.stringify({ stage, checked, modelCalls: 0 }));
} finally { await browser.close(); server.stop(true); }
