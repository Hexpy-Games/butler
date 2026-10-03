import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "./native-app-server.ts";
import { smokeBrowserArgs } from "./smoke-browser.ts";

export interface VisualNode {
  tag: string;
  slot: string | null;
  children: number;
  text: string | null;
  rect: number[];
  paint: string[];
}

export interface NewChatVisualCase {
  nodes: VisualNode[];
  hover: VisualNode[];
  focus: VisualNode[];
}

/** The same DS treatment applies to completed and pending onboarding. */
export async function assertNewChatSurfaces(page: Page): Promise<void> {
  const surface = await page.locator('[data-test-class="new-chat-empty-state"]').evaluate(root => {
    const alpha = (color: string) => {
      const context = document.createElement("canvas").getContext("2d")!;
      context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3]!;
    };
    const header = root.querySelector("header")!;
    const heading = header.querySelector("h2")!.getBoundingClientRect();
    const icons = [...header.querySelectorAll<HTMLElement>('[data-slot$="title-icon"]')]
      .filter(icon => getComputedStyle(icon).display !== "none").map(icon => icon.getBoundingClientRect());
    const cards = [...root.querySelectorAll('[data-test-class="new-chat-suggestion"]')].map(card => {
      const style = getComputedStyle(card);
      return { backgroundAlpha: alpha(style.backgroundColor), tintAlpha: alpha(style.getPropertyValue("--tinted-glass-tint")),
        backdrop: style.backdropFilter };
    });
    return { headerAlphas: [header, ...header.querySelectorAll("*")].map(node => alpha(getComputedStyle(node).backgroundColor)),
      iconsSeparate: icons.length === 1 && icons.every(icon => icon.right < heading.left || icon.bottom <= heading.top), cards };
  });
  assert(surface.headerAlphas.every(alpha => alpha === 0), "Hero copy stays directly over the wallpaper");
  assert(surface.iconsSeparate, "Butler mark stays outside the heading");
  assert(surface.cards.length > 0);
  assert(surface.cards.every(card => card.backgroundAlpha < 255 && card.tintAlpha < 255 && card.backdrop.includes("blur")),
    `Suggestion cards retain TintedGlass: ${JSON.stringify(surface.cards)}`);
}

/** Sample the composited screenshot: WebGL releases its buffer after presenting. */
async function assertWallpaperPixels(page: Page, screenshot: Buffer, coastal: boolean): Promise<void> {
  const colors = await page.evaluate(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const colors = new Set<string>();
    for (let y = 600; y < 720; y += 12) for (let x = Math.floor(image.width * 0.75); x < image.width * 0.9; x += 12) {
      colors.add([...context.getImageData(x, y, 1, 1).data].join(","));
    }
    return colors.size;
  }, `data:image/png;base64,${screenshot.toString("base64")}`);
  // Plain pages may still have DS shadows; hidden/zero-sized wallpaper is checked separately.
  if (coastal) assert(colors > 16, `Coastal scene: ${colors} painted colors`);
}

/** Actual rendered descendants, including wrappers and pseudo-element surfaces. */
async function readVisualNodes(page: Page, selector: string): Promise<VisualNode[]> {
  return await page.locator(selector).evaluateAll(roots => {
    const paint = (style: CSSStyleDeclaration) => [style.backgroundColor, style.backgroundImage,
      style.backgroundSize, style.borderColor, style.borderRadius, style.boxShadow,
      style.backdropFilter, style.color, style.fontSize, style.fontWeight, style.lineHeight];
    return roots.flatMap(root => [root, ...root.querySelectorAll("*")].map(node => {
      const rect = node.getBoundingClientRect();
      return { tag: node.tagName, slot: node.getAttribute("data-slot"), children: node.children.length,
        text: node.children.length ? null : node.textContent,
        rect: [rect.x, rect.y, rect.width, rect.height],
        paint: [getComputedStyle(node).display, ...paint(getComputedStyle(node)),
          ...paint(getComputedStyle(node, "::before")), ...paint(getComputedStyle(node, "::after"))] };
    }));
  });
}

async function settleNewChat(page: Page, coastal: boolean): Promise<void> {
  await page.locator('[data-test-class="new-chat-suggestion"]').nth(3).waitFor();
  await page.locator('[data-slot="prompt-suggestion-moment"]').getByText("오후 3:25", { exact: true }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode()));
  });
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  if (coastal) {
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-module="butler.shoreline"]');
      return canvas && canvas.width > 0 && canvas.height > 0 && getComputedStyle(canvas).visibility === "visible";
    });
  } else {
    // Wallpaper retains a cleared canvas after switching to `none` (its public contract).
    await page.waitForFunction(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[data-test-class~="wallpaper"]')];
      return canvases.every(canvas => {
        return canvas.dataset.module === "none" && canvas.width === 0 && getComputedStyle(canvas).visibility === "hidden";
      });
    });
  }
}

export async function captureNewChatMatrix(uiRoot: string, output: string) {
  mkdirSync(output, { recursive: true });
  const server = await createNativeAppServer({ uiRoot: resolve(uiRoot) });
  const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
  const cases: Record<string, NewChatVisualCase> = {};
  const screenshots: string[] = [];
  try {
    // Reuse one context: sandboxed single-process Chromium cannot replace contexts.
    const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "Asia/Seoul" });
    await page.clock.setFixedTime(new Date("2026-10-03T06:25:00Z"));
    await page.route("**/new-chat-briefing*", async route => {
      const response = await route.fetch();
      const body = await response.json();
      (body.data ?? body).moment = "오후 3:25";
      await route.fulfill({ response, json: body });
    });
    await server.signIn(page);
    for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const scene of ["coastal", "none"]) {
      const key = `${width}-${theme}-${scene}`;
      await page.setViewportSize({ width, height: 900 });
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
        wallpaper: { source: scene === "coastal" ? { kind: "live", module: "butler.shoreline", params: { realtime: false } } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
      await page.goto(server.url);
      await page.locator(`[data-theme="${theme}"]`).first().waitFor();
      await settleNewChat(page, scene === "coastal");
      const roots = '[data-test-class="new-chat-empty-state"] header, [data-test-class="new-chat-suggestion"]';
      const nodes = await readVisualNodes(page, roots);
      const path = join(output, `${key}.png`);
      const screenshot = await page.screenshot({ path }); screenshots.push(path);
      await assertWallpaperPixels(page, screenshot, scene === "coastal");
      const firstCard = '[data-test-class="new-chat-suggestion"] >> nth=0';
      await page.locator(firstCard).hover();
      const hover = await readVisualNodes(page, firstCard);
      await page.mouse.move(0, 0);
      await page.locator(firstCard).getByRole("button").focus();
      const focus = await readVisualNodes(page, firstCard);
      cases[key] = { nodes, hover, focus };
    }
    assert.equal(server.stubModelCalls.length, 0, "New chat rendering requires no model calls");
    return { cases, screenshots, modelCalls: server.stubModelCalls.length };
  } finally { await browser.close(); await server.stop(); }
}

export function compareNewChatCase(actual: NewChatVisualCase, expected: NewChatVisualCase): number {
  let maxGeometryDelta = 0;
  for (const state of ["nodes", "hover", "focus"] as const) {
    assert.equal(actual[state].length, expected[state].length, `${state}: descendant structure`);
    actual[state].forEach((node, index) => {
      const reference = expected[state][index]!;
      const { rect, ...structure } = node;
      const { rect: baselineRect, ...baselineStructure } = reference;
      assert.deepEqual(structure, baselineStructure, `${state}[${index}]: content and computed surfaces`);
      rect.forEach((value, axis) => {
        const delta = Math.abs(value - baselineRect[axis]!);
        maxGeometryDelta = Math.max(maxGeometryDelta, delta);
        assert(delta <= 1, `${state}[${index}].rect[${axis}]: ${value} vs ${baselineRect[axis]} (1px tolerance)`);
      });
    });
  }
  return maxGeometryDelta;
}
