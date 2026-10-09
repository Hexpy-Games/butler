import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { Locator, Page } from "playwright";

// AdaptiveShell frame="cards" geometry on the static DS site (run after build:ds-site):
// - opening the inspector never moves the title row's trailing icons (⋯ · browser · inspector);
// - the cards frame draws its cards (radius, inset) and the inspector card sits under the title row;
// - one rhythm: the gap between cards (chat | browser, content | inspector) equals the 8px right inset, and
//   each resize handle's grab zone spans the gap with its grip centred in it;
// - the sidebar peek is visible under reduced motion (it was laid out but transparent);
// - the window bounds every card: with a long conversation and a tall inspector both cards keep the 8px
//   bottom inset and their rounded bottom corners, and an empty new chat (its stage sized to the window) keeps the
//   title row's icons on screen after its composer takes focus (nothing scrolls the shell);
// - PopupWindowChrome: on macOS the lock sits as far from the green light as the main titlebar's first
//   leading glyph (the floating toggle's) sits from its own lights; on Windows nothing is reserved at the start.
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
  tall: "Cards frame: tall content stays inside the window",
} as const;
const POPUP_STORY = { mac: "macOS pop-up window", windows: "Windows pop-up window" } as const;
const bottomInsets: string[] = [];
const popupGaps: string[] = [];
const tabInsets: string[] = [];
const cardGaps: string[] = [];

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
    const [logical, logicalHeight] = (host.dataset.dsScaledFrame ?? "").split("x").map(Number);
    const scale = box.width / (logical || box.width);
    const local = (rect: DOMRect | undefined) => rect && ({
      left: (rect.left - box.left) / scale, right: (rect.right - box.left) / scale,
      top: (rect.top - box.top) / scale, bottom: (rect.bottom - box.top) / scale,
    });
    const icons = host.querySelector("[data-ds-title-icons]")?.getBoundingClientRect();
    const card = host.querySelector("[data-slot=adaptive-shell-card]");
    const inspector = host.querySelector("[data-slot=adaptive-shell-inspector]");
    const title = host.querySelector("[data-slot=adaptive-shell-title]")?.getBoundingClientRect();
    const shell = host.querySelector("[data-slot=adaptive-shell-workspace]")?.parentElement;
    const radii = (node: Element) => {
      const style = getComputedStyle(node);
      return { radius: style.borderTopLeftRadius, bottomRadius: [style.borderBottomLeftRadius, style.borderBottomRightRadius] };
    };
    return {
      width: logical, height: logicalHeight,
      icons: local(icons), title: local(title),
      // Anything that scrolls the shell (or the frame around it) moves the whole window off its title row;
      // overflow is how far the shell could scroll (focus or scrollIntoView would take it).
      scroll: { frame: host.scrollTop, shell: shell?.scrollTop ?? -1, overflow: shell ? shell.scrollHeight - shell.clientHeight : -1 },
      card: card ? { ...local(card.getBoundingClientRect()), ...radii(card) } : null,
      inspector: inspector && getComputedStyle(inspector).visibility === "visible"
        ? { ...local(inspector.getBoundingClientRect()), ...radii(inspector) } : null,
    };
  });
}

const near = (a: number | undefined, b: number | undefined, tolerance = 0.75) =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= tolerance;

type WindowFacts = Awaited<ReturnType<typeof windowFacts>>;
type CardFacts = NonNullable<WindowFacts["card"]>;

/** A card bounded by the window: 8px off its bottom edge, with both rounded bottom corners. */
function assertBottomInset(facts: WindowFacts, card: CardFacts | null, label: string): void {
  assert(card, `${label}: card missing ${JSON.stringify(facts)}`);
  const inset = facts.height - (card.bottom ?? 0);
  bottomInsets.push(`${label} ${inset.toFixed(2)}`);
  assert(near(inset, 8) && card.bottomRadius.every((radius) => radius === "12px"),
    `${label}: the card should end 8px above the window's bottom edge with 12px bottom corners: ${JSON.stringify(card)} in ${facts.width}x${facts.height}`);
  assert(facts.scroll.frame === 0 && facts.scroll.shell === 0 && facts.scroll.overflow === 0,
    `${label}: the shell must not scroll: ${JSON.stringify(facts.scroll)}`);
}

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
    assertBottomInset(closed, closed.card, `${theme} 1440 card`);
    assertBottomInset(open, open.inspector, `${theme} 1440 inspector`);
    const narrow = await windowFacts(frames.nth(2));
    assertBottomInset(narrow, narrow.card, `${theme} 1100 card`);
    assertBottomInset(narrow, narrow.inspector, `${theme} 1100 inspector`);

    // Tall content: a long conversation, a tall inspector, an empty new chat sized to the window.
    const tall = page.locator(`[data-ds-story="${STORY.tall}"] [data-ds-theme="${theme}"]`).first();
    const tallFrames = tall.locator("[data-ds-scaled-frame]");
    assert((await tallFrames.count()) === 3, `${theme}: the tall-content story renders 3 windows`);
    const long = await windowFacts(tallFrames.nth(0));
    assert(near(long.card?.top, 49) && near(long.card?.right, 1440 - 8), `${theme}: long conversation card frame: ${JSON.stringify(long.card)}`);
    assertBottomInset(long, long.card, `${theme} 1440 long conversation`);
    const tallInspector = await windowFacts(tallFrames.nth(1));
    assertBottomInset(tallInspector, tallInspector.card, `${theme} 1100 long conversation`);
    assertBottomInset(tallInspector, tallInspector.inspector, `${theme} 1100 tall inspector`);
    assert(near(tallInspector.inspector?.top, 49), `${theme}: tall inspector starts under the title row: ${JSON.stringify(tallInspector.inspector)}`);
    for (const [index, name] of ["long-conversation-1440", "tall-inspector-1100", "empty-conversation-1100"].entries()) {
      await tallFrames.nth(index).screenshot({ path: join(shots, `tall-${name}-${theme}.png`) });
    }
    // The composer takes focus and is scrolled into view as on a new chat; neither may move the window off
    // its title row.
    await tallFrames.nth(2).locator("[data-slot=adaptive-shell-card] textarea").first()
      .evaluate((node) => { (node as HTMLElement).focus(); node.scrollIntoView({ block: "end" }); });
    const empty = await windowFacts(tallFrames.nth(2));
    assert(empty.icons && (empty.icons.top ?? -1) >= 0 && (empty.icons.bottom ?? Infinity) <= 48,
      `${theme}: empty conversation title icons must stay in the title row: ${JSON.stringify(empty.icons)}`);
    assertBottomInset(empty, empty.card, `${theme} 1100 empty conversation`);
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

    // One rhythm: the gap between two cards (outer edge to outer edge) equals the right inset (the last
    // card's outer edge to the window edge), for the chat | browser split and the content | inspector
    // cards, at 1440 and 1100. Each resize handle's grab zone spans the whole gap and its grip sits centred in it.
    const gapFrames = [
      ["split 1440", page.locator(`[data-ds-story="${STORY.browser}"] [data-ds-theme="${theme}"] [data-ds-scaled-frame]`).nth(0)],
      ["split 1100", page.locator(`[data-ds-story="${STORY.browser}"] [data-ds-theme="${theme}"] [data-ds-scaled-frame]`).nth(1)],
      ["inspector 1440", frames.nth(1)],
      ["inspector 1100", frames.nth(2)],
    ] as const;
    for (const [label, frame] of gapFrames) {
      const gap = await frame.evaluate((node) => {
        const host = node as HTMLElement;
        const box = (host.firstElementChild as HTMLElement).getBoundingClientRect();
        const scale = box.width / Number(host.dataset.dsScaledFrame?.split("x")[0]);
        const rect = (selector: string) => host.querySelector(selector)?.getBoundingClientRect();
        const split = rect("[data-slot=adaptive-shell-split-chat]");
        const lead = split ?? rect("[data-slot=adaptive-shell-card]");
        const trail = split ? rect("[data-slot=adaptive-shell-split-pane] [data-slot=browser-pane]") : rect("[data-slot=adaptive-shell-inspector]");
        const handle = host.querySelector<HTMLElement>(split ? "[data-slot=adaptive-shell-split] > [role=separator]" : "[role=separator][data-side=right]");
        // Hover state is what shows the grip; its box is laid out (opacity 0) either way.
        const grip = handle?.querySelector("[data-slot=resize-grip]")?.getBoundingClientRect();
        const handleBox = handle?.getBoundingClientRect();
        if (!lead || !trail || !handleBox || !grip) return null;
        const mid = (lead.right + trail.left) / 2;
        return {
          gap: (trail.left - lead.right) / scale,
          inset: (box.right - trail.right) / scale,
          handleWidth: handleBox.width / scale,
          handleCovers: handleBox.left <= lead.right + 0.01 * scale && handleBox.right >= trail.left - 0.01 * scale,
          gripOffset: ((grip.left + grip.right) / 2 - mid) / scale,
        };
      });
      assert(gap, `${theme} ${label}: cards or handle missing`);
      cardGaps.push(`${theme} ${label}: gap ${gap.gap.toFixed(2)} inset ${gap.inset.toFixed(2)} handle ${gap.handleWidth.toFixed(2)} grip ${gap.gripOffset.toFixed(2)}`);
      assert(near(gap.inset, 8, 0.5) && near(gap.gap, gap.inset, 0.5),
        `${theme} ${label}: the gap between cards must equal the right inset (8px): ${JSON.stringify(gap)}`);
      assert(gap.handleWidth >= gap.gap - 0.01 && gap.handleCovers,
        `${theme} ${label}: the resize handle's grab zone must span the whole gap: ${JSON.stringify(gap)}`);
      assert(near(gap.gripOffset, 0, 0.5), `${theme} ${label}: the grip must sit centred in the gap: ${JSON.stringify(gap)}`);
    }

    for (const story of await page.locator('[data-ds-story^="Cards frame:"]').all()) {
      const name = (await story.getAttribute("data-ds-story"))!.replace(/[^a-z0-9]+/giu, "-").slice(0, 60);
      await story.locator(`[data-ds-theme="${theme}"]`).first().screenshot({ path: join(shots, `${name}-${theme}.png`) });
    }
    // PopupWindowChrome leading gap. The main titlebar (TitlebarShell beside the floating toggle) puts its
    // first glyph at --traffic-controls-width + --chrome-toggle-inset + the toggle's inner inset, with the
    // lights at x 20 (main.mjs); a pop-up's lights sit at x 12. Both draw the same lights, so the expected
    // gap from the green light is the main glyph start minus (20 + the lights' width).
    await page.goto(`${origin}/?page=blocks/PopupWindowChrome&theme=${theme}`, { waitUntil: "networkidle" });
    const mac = page.locator(`[data-ds-story="${POPUP_STORY.mac}"] [data-ds-theme="${theme}"]`).first();
    await mac.waitFor({ state: "visible", timeout: 20_000 });
    const popup = await mac.evaluate((node) => {
      const px = (name: string) => {
        const probe = document.createElement("div");
        probe.style.width = `var(${name})`;
        document.documentElement.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      };
      const lights = node.querySelector("[data-ds-popup-lights]")!.getBoundingClientRect();
      const chrome = node.querySelector("[data-slot=popup-window-chrome]")!.getBoundingClientRect();
      const lock = node.querySelector("[data-slot=popup-window-chrome] header [role=img]")!.getBoundingClientRect();
      const mainGlyphStart = px("--traffic-controls-width") + px("--chrome-toggle-inset")
        + (px("--chrome-floating-toggle-size") - px("--chrome-floating-toggle-icon-size")) / 2;
      return { gap: lock.left - lights.right, lightsLeft: lights.left - chrome.left, expected: mainGlyphStart - (20 + lights.width) };
    });
    popupGaps.push(`${theme} macOS ${popup.gap.toFixed(2)} (titlebar ${popup.expected.toFixed(2)})`);
    assert(near(popup.lightsLeft, 12) && popup.expected > 0 && near(popup.gap, popup.expected, 0.5),
      `${theme}: the pop-up lock must sit as far from the green light as the main titlebar's leading glyph: ${JSON.stringify(popup)}`);
    const win = page.locator(`[data-ds-story="${POPUP_STORY.windows}"] [data-ds-theme="${theme}"]`).first();
    const winFacts = await win.evaluate((node) => {
      const chrome = node.querySelector("[data-slot=popup-window-chrome]")!.getBoundingClientRect();
      const lock = node.querySelector("[data-slot=popup-window-chrome] header [role=img]")!.getBoundingClientRect();
      const controls = node.querySelector("[data-slot=popup-window-chrome] header .no-drag")?.getBoundingClientRect();
      return { lockLeft: lock.left - chrome.left, controlsRight: controls ? chrome.right - controls.right : -1, lights: node.querySelector("[data-ds-popup-lights]") !== null };
    });
    popupGaps.push(`${theme} Windows lock ${winFacts.lockLeft.toFixed(2)}`);
    assert(!winFacts.lights && near(winFacts.lockLeft, 12) && near(winFacts.controlsRight, 8),
      `${theme}: the Windows pop-up reserves nothing at the start and keeps its controls at the end: ${JSON.stringify(winFacts)}`);
    await mac.screenshot({ path: join(shots, `popup-macos-${theme}.png`) });
    await win.screenshot({ path: join(shots, `popup-windows-${theme}.png`) });

    assert(errors.length === 0, `${theme}: page errors ${errors.join(" | ")}`);
    await context.close();
  }
  console.log(`card gaps (px): ${cardGaps.join(" · ")}`);
  console.log(`first tab insets (px): ${tabInsets.join(" · ")}`);
  console.log(`card bottom insets (px): ${bottomInsets.join(" · ")}`);
  console.log(`pop-up leading gaps (px): ${popupGaps.join(" · ")}`);
  console.log(`ds-shell-cards smoke: ok (screenshots in ${shots})`);
} finally {
  await browser.close();
  server.stop(true);
}
