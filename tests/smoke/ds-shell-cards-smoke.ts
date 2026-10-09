import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { Locator, Page } from "playwright";

// AdaptiveShell frame="cards" geometry on the static DS site (run after build:ds-site):
// - opening the inspector never moves the title row's trailing icons (⋯ · browser · inspector);
// - the cards frame draws its cards (radius, inset) and the inspector card sits under the title row;
// - the sidebar peek is visible under reduced motion (it was laid out but transparent).
// Screenshots of every cards story, light and dark, land in .tmp/ds-shell-cards for review.

const uiRoot = resolve(process.cwd(), "packages", "butler-app", "client", "ui");
const distDir = resolve(process.argv[2] ?? join(uiRoot, "dist-ds-site"));
const shots = resolve(process.cwd(), ".tmp", "ds-shell-cards");
mkdirSync(shots, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(existsSync(join(distDir, "index.html")), `missing ${distDir}/index.html; run build:ds-site first`);

function serve(pathname: string): Response {
  const full = normalize(join(distDir, decodeURIComponent(pathname)));
  if (full !== distDir && !full.startsWith(distDir + sep)) return new Response("forbidden", { status: 403 });
  const file = existsSync(full) && statSync(full).isDirectory() ? join(full, "index.html") : full;
  return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => serve(new URL(request.url).pathname) });
const origin = `http://127.0.0.1:${server.port}`;

const STORY = {
  inspector: "Cards frame: inspector open, title icons stay (closed above, open below)",
  peek: "Cards frame: sidebar collapsed and peek",
  flatPeek: "Sidebar peek",
  browser: "Cards frame: conversation + browser (1440, and 1100 with the sidebar stepped aside)",
  hub: "Cards frame: standalone browser",
} as const;
const tabInsets: string[] = [];

async function openShellPage(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto(`${origin}/?page=blocks/AdaptiveShell&theme=${theme}&width=wide`, { waitUntil: "networkidle" });
  await page.locator(`[data-ds-story="${STORY.inspector}"]`).first().waitFor({ state: "visible", timeout: 20_000 });
}

/** Geometry of one window frame in its own (unscaled) pixels. */
async function windowFacts(frame: Locator) {
  return frame.evaluate((node) => {
    const host = node as HTMLElement;
    // The scaled window is the host's child (the host draws a 1px viewer border around it).
    const box = (host.firstElementChild as HTMLElement).getBoundingClientRect();
    const logical = Number(host.dataset.dsScaledFrame?.split("x")[0] ?? box.width);
    const scale = box.width / logical;
    const local = (rect: DOMRect | undefined) => rect && ({
      left: (rect.left - box.left) / scale, right: (rect.right - box.left) / scale,
      top: (rect.top - box.top) / scale, bottom: (rect.bottom - box.top) / scale,
    });
    const icons = host.querySelector("[data-ds-title-icons]")?.getBoundingClientRect();
    const card = host.querySelector("[data-slot=adaptive-shell-card]");
    const inspector = host.querySelector("[data-slot=adaptive-shell-inspector]");
    const title = host.querySelector("[data-slot=adaptive-shell-title]")?.getBoundingClientRect();
    return {
      icons: local(icons), title: local(title),
      card: card ? { ...local(card.getBoundingClientRect()), radius: getComputedStyle(card).borderTopLeftRadius } : null,
      inspector: inspector && getComputedStyle(inspector).visibility === "visible"
        ? { ...local(inspector.getBoundingClientRect()), radius: getComputedStyle(inspector).borderTopLeftRadius } : null,
    };
  });
}

const near = (a: number | undefined, b: number | undefined, tolerance = 0.75) =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= tolerance;

const browser = await launchSmokeBrowser();
try {
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce", colorScheme: theme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openShellPage(page, theme);

    const story = page.locator(`[data-ds-story="${STORY.inspector}"] [data-ds-theme="${theme}"]`).first();
    const frames = story.locator("[data-ds-scaled-frame]");
    assert((await frames.count()) === 3, `${theme}: the inspector story renders 3 windows`);
    const closed = await windowFacts(frames.nth(0));
    const open = await windowFacts(frames.nth(1));
    assert(closed.icons && open.icons, `${theme}: title icons missing ${JSON.stringify({ closed, open })}`);
    assert(near(closed.icons.left, open.icons.left) && near(closed.icons.right, open.icons.right),
      `${theme}: opening the inspector moved the title icons: closed ${JSON.stringify(closed.icons)} open ${JSON.stringify(open.icons)}`);
    assert(near(closed.icons.right, 1440 - 18 - 1, 1.5), `${theme}: title icons should end 18px off the window edge: ${closed.icons.right}`);
    assert(closed.card?.radius === "12px" && near(closed.card.top, 49) && near(closed.card.right, 1440 - 8) && near(closed.card.bottom, 900 - 8),
      `${theme}: the content card should be inset 8 under the 48px title row (+1px frame) with a 12px radius: ${JSON.stringify(closed.card)}`);
    assert(open.inspector && open.inspector.radius === "12px" && near(open.inspector.top, 49) && near(open.inspector.right, 1440 - 8),
      `${theme}: the inspector should be a card under the title row: ${JSON.stringify(open.inspector)}`);
    assert(open.card && near((open.inspector.left ?? 0) - (open.card.right ?? 0), 8),
      `${theme}: one 8px gap between the content card and the inspector card: ${JSON.stringify({ card: open.card, inspector: open.inspector })}`);
    await story.screenshot({ path: join(shots, `inspector-${theme}.png`) });

    for (const name of [STORY.peek, STORY.flatPeek]) {
      const peekStory = page.locator(`[data-ds-story="${name}"] [data-ds-theme="${theme}"]`).first();
      const sidebar = peekStory.locator('[data-left-peek="true"] > [data-slot="adaptive-shell-sidebar"]').first();
      await sidebar.waitFor({ state: "attached" });
      const style = await sidebar.evaluate((node) => {
        const computed = getComputedStyle(node);
        return { opacity: computed.opacity, visibility: computed.visibility, width: node.getBoundingClientRect().width };
      });
      assert(style.opacity === "1" && style.visibility === "visible" && style.width > 0,
        `${theme}: "${name}" peek must be visible under reduced motion: ${JSON.stringify(style)}`);
      await peekStory.screenshot({ path: join(shots, `${name === STORY.peek ? "peek-cards" : "peek-flat"}-${theme}.png`) });
    }

    // The browser sheet's first tab sits as far from the sheet's left edge as from its top edge
    // (both measured from the sheet's outer edge to the tab's box), at 1440 and 1100 and standalone.
    for (const [name, index] of [[STORY.browser, 0], [STORY.browser, 1], [STORY.hub, 0]] as const) {
      const frame = page.locator(`[data-ds-story="${name}"] [data-ds-theme="${theme}"] [data-ds-scaled-frame]`).nth(index);
      const inset = await frame.evaluate((node) => {
        const host = node as HTMLElement;
        const box = (host.firstElementChild as HTMLElement).getBoundingClientRect();
        const scale = box.width / Number(host.dataset.dsScaledFrame?.split("x")[0]);
        const sheet = host.querySelector("[data-slot=browser-pane]")!.getBoundingClientRect();
        // Left: the row's leftmost item (the first tab; the group chip in the standalone Browser, which
        // is centred on the taller tabs). Top: the first tab.
        const first = host.querySelector("[data-slot=browser-pane] [data-slot=tab-strip] :is([data-test-class~=tab-strip-chip] [aria-expanded], [role=tab])")!.getBoundingClientRect();
        const tab = host.querySelector("[data-slot=browser-pane] [role=tab]")!.getBoundingClientRect();
        return { left: (first.left - sheet.left) / scale, top: (tab.top - sheet.top) / scale };
      });
      tabInsets.push(`${theme} ${name === STORY.hub ? "standalone" : index === 0 ? "1440" : "1100"}: left ${inset.left.toFixed(2)} top ${inset.top.toFixed(2)}`);
      assert(near(inset.left, inset.top, 0.5), `${theme}: the first tab's left and top gaps must match: ${JSON.stringify(inset)}`);
    }

    for (const story of await page.locator('[data-ds-story^="Cards frame:"]').all()) {
      const name = (await story.getAttribute("data-ds-story"))!.replace(/[^a-z0-9]+/giu, "-").slice(0, 60);
      await story.locator(`[data-ds-theme="${theme}"]`).first().screenshot({ path: join(shots, `${name}-${theme}.png`) });
    }
    assert(errors.length === 0, `${theme}: page errors ${errors.join(" | ")}`);
    await context.close();
  }
  console.log(`first tab insets (px): ${tabInsets.join(" · ")}`);
  console.log(`ds-shell-cards smoke: ok (screenshots in ${shots})`);
} finally {
  await browser.close();
  server.stop(true);
}
