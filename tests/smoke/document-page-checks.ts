// UI behavior smoke: reading geometry and the host's trailing header action.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

export const documentHarnessPlugin = {
  name: "document-host-harness",
  resolveId(id: string) { if (id === "/document-host-harness") return id; },
  load(id: string) {
    if (id !== "/document-host-harness") return;
    return `import React from "react";
      import { createRoot } from "react-dom/client";
      import { DocumentPage } from "/src/components/documents/DocumentPage.tsx";
      import { IconButton, X } from "@/butler-ds";
      export function render(id) {
        document.getElementById("root").hidden = true;
        const element = document.createElement("div"); document.body.append(element);
        const root = createRoot(element);
        root.render(React.createElement(DocumentPage, { id, trailing: React.createElement(IconButton,
          { label: "Host close", onClick: () => { root.unmount(); element.remove(); } }, React.createElement(X)) }));
      }`;
  },
};

export async function checkTrailing(page: Page, base: string, id: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}?visual=components&theme=light&locale=ko`);
  await page.evaluate(async id => {
    const path = "/document-host-harness";
    (await import(/* @vite-ignore */ path)).render(id);
  }, id);
  const close = page.getByRole("button", { name: "Host close", exact: true });
  await close.waitFor();
  const buttons = page.locator('[data-test-class="editable-document"] > :first-child button');
  assert.deepEqual(await buttons.evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => node.getAttribute("aria-label"))), ["버전 기록", "원래 대화", "내보내기", "Host close"]);
  const rows = await buttons.evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().y));
  assert(rows.every(y => Math.abs(y - rows[0]!) < 1), JSON.stringify(rows));
  await close.focus(); await page.keyboard.press("Enter");
  await close.waitFor({ state: "hidden" });
}

export async function measureDocumentLayout(page: Page) {
  return page.locator('[data-test-class="editable-document"]').evaluate(node => {
    const root = node.querySelector('[data-document-id], [data-document-read-only]')!;
    const host = node.closest('[data-test-class="file-viewer-page"], [data-test-class="document-reading-page"]')!;
    const column = host.firstElementChild!.firstElementChild!;
    const contentLeft = column.getBoundingClientRect().left + parseFloat(getComputedStyle(column).paddingLeft);
    const contentWidth = column.clientWidth - parseFloat(getComputedStyle(column).paddingLeft) - parseFloat(getComputedStyle(column).paddingRight);
    const wrappers = [];
    for (let element = root.parentElement; element && element !== column; element = element.parentElement) {
      const css = getComputedStyle(element);
      wrappers.push({ background: css.backgroundColor, border: css.borderWidth, shadow: css.boxShadow });
    }
    return { inset: parseFloat(getComputedStyle(host).paddingLeft) + parseFloat(getComputedStyle(column).paddingLeft),
      maxWidth: getComputedStyle(host).maxWidth, bodyWidth: root.getBoundingClientRect().width, columnWidth: contentWidth,
      hostLeft: host.getBoundingClientRect().left, contentLeft, textLeft: root.getBoundingClientRect().left,
      pageLeft: node.getBoundingClientRect().left, wrappers };
  });
}
export function assertDocumentLayout(layout: Awaited<ReturnType<typeof measureDocumentLayout>>, _width: number) {
  assert.equal(layout.inset, 48);
  assert.equal(layout.maxWidth, "760px");
  assert(layout.bodyWidth <= 760 && Math.abs(layout.bodyWidth - layout.columnWidth) <= 1, JSON.stringify(layout));
  assert(Math.abs(layout.textLeft - layout.contentLeft) <= 1, JSON.stringify(layout));
  assert(Math.abs(layout.pageLeft - layout.contentLeft) <= 1, "DocumentPage adds no inset: " + JSON.stringify(layout));
  assert(layout.wrappers.every(css => css.background === "rgba(0, 0, 0, 0)" && parseFloat(css.border) === 0 && css.shadow === "none"), JSON.stringify(layout));
}

/** Overflow is reachable inside a horizontal scroller, never lost beyond a clipping ancestor. */
export async function assertDocumentOverflow(page: Page) {
  const result = await page.locator('[data-slot="document-editor-page"]').evaluate(root => {
    const failures: string[] = [], scrollers: string[] = [];
    const horizontal = (node: Element) => /^(auto|scroll)$/u.test(getComputedStyle(node).overflowX);
    for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
      if (!element.clientWidth || element.scrollWidth <= element.clientWidth + 1) continue;
      let container: Element | null = element;
      while (container && container !== root && !horizontal(container)) {
        if (/^(hidden|clip)$/u.test(getComputedStyle(container).overflowX)) break;
        container = container.parentElement;
      }
      if (!container || !horizontal(container)) failures.push(element.tagName + ":" + element.scrollWidth + "/" + element.clientWidth);
      else {
        const before = container.scrollLeft;
        container.scrollLeft = container.scrollWidth;
        if (container.scrollLeft <= 0) failures.push("unreachable:" + element.tagName);
        container.scrollLeft = before;
        scrollers.push(container.tagName);
      }
    }
    return { failures, scrollers };
  });
  assert.deepEqual(result.failures, [], JSON.stringify(result));
  assert(result.scrollers.length > 0, "wide content has a reachable horizontal scroller");
  return result;
}
export async function checkDocumentImage(page: Page, width: number, evidence: string, scope = "[data-document-id]") {
  const frames = page.locator(`${scope} [data-slot="media-frame"]`);
  await frames.first().waitFor();
  await frames.locator("img").evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
  const boxes = await frames.evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(), parent = node.parentElement!.getBoundingClientRect(), css = getComputedStyle(node);
    const image = node.querySelector("img")!, picture = image.getBoundingClientRect(), imageCss = getComputedStyle(image);
    return { width: r.width, height: r.height, available: parent.width, natural: node.hasAttribute("data-natural"),
      cssWidth: (node as HTMLElement).style.getPropertyValue("--media-natural-width"),
      picture: { width: picture.width, height: picture.height }, chrome: { background: css.backgroundColor, radius: css.borderRadius, border: css.borderWidth },
      imageBorder: imageCss.borderWidth, imageShadow: imageCss.boxShadow };
  }));
  for (const box of boxes) {
    assert(box.natural && box.cssWidth === "600px", JSON.stringify(box));
    const expected = Math.min(600, box.available);
    assert(Math.abs(box.width - expected) < 1 && Math.abs(box.height - expected * 2 / 3) < 1, JSON.stringify(box));
    assert(Math.abs(box.picture.width - box.width) < 1 && Math.abs(box.picture.height - box.height) < 1, JSON.stringify(box));
    assert.equal(parseFloat(box.imageBorder), 0); assert.equal(box.imageShadow, "none");
  }
  // Record the DS natural mode's retained background/radius for the owner; product does not override DS.
  writeFileSync(join(evidence, `document-images-${width}.json`), JSON.stringify(boxes, null, 2));
}

/** Compare the real title and every action on the shared title line. */
export async function checkTitleLine(page: Page, options: {
  width: number; theme: string; stage: string; evidence: string; fullPage: boolean;
}) {
  const { width, theme, stage, evidence, fullPage } = options;
  const surface = fullPage ? "drawer" : "fv";
  const host = fullPage ? '[data-test-class="document-reading-page"]' : '[data-test-class="file-viewer"]';
  const document = page.locator(`${host} [data-test-class="editable-document"]`);
  await document.waitFor();
  await page.waitForFunction(selector => {
    const node = window.document.querySelector(selector);
    return node && window.document.getAnimations().every(animation => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return !(target instanceof Element && target.contains(node))
        || (!animation.pending && ["finished", "idle"].includes(animation.playState));
    });
  }, `${host} [data-test-class="editable-document"]`);
  const beforeTitleWidth = await document.evaluate(node => {
    const inline = node.querySelector<HTMLElement>('[data-slot="document-editor-actions"]')!;
    const menu = node.querySelector<HTMLElement>('[data-slot="document-editor-menu"]');
    inline.style.display = "flex"; if (menu) menu.style.display = "none";
    const width = node.querySelector("h2")!.getBoundingClientRect().width;
    inline.style.removeProperty("display"); menu?.style.removeProperty("display");
    return width;
  });
  const geometry = await document.locator(":scope > :first-child").evaluate(row => {
    const center = (node: Element) => { const rect = node.getBoundingClientRect(); return rect.y + rect.height / 2; };
    const title = row.querySelector("h2")!;
    return { title: center(title), titleWidth: title.getBoundingClientRect().width, clientWidth: title.clientWidth, scrollWidth: title.scrollWidth, buttons: [...row.querySelectorAll("button")].filter(button => button.getClientRects().length).map(button => ({
      label: button.getAttribute("aria-label") ?? button.textContent, center: center(button),
    })) };
  });
  if (stage !== "before") {
    if (!fullPage) {
      assert(await document.locator('[data-test-class="file-viewer-close"]').isVisible());
      if (width === 390) assert(await document.locator('[data-test-class="file-viewer-back"]').isVisible());
    }
    assert.equal(await document.locator('[data-slot="document-editor-actions"]').isVisible(), width !== 390);
    assert.equal(await document.locator('[data-slot="document-editor-menu"] button').isVisible(), width === 390);
    if (width === 390) { assert(geometry.titleWidth >= 80, JSON.stringify(geometry)); assert(geometry.scrollWidth <= geometry.clientWidth, "fixture title fits without ellipsis"); }
  }
  assert(geometry.buttons.length > 0, "the document title line has actions");
  const result = { check: "document-title-line", stage, surface, width, theme, beforeTitleWidth, ...geometry };
  console.log(JSON.stringify(result));
  const clip = await document.evaluate(node => {
    const row = node.firstElementChild!.getBoundingClientRect();
    const body = node.querySelector('[data-slot="document-editor-page"]')!.getBoundingClientRect();
    const x = Math.max(0, row.left - 16), y = Math.max(0, row.top - 16);
    return { x, y, width: Math.min(window.innerWidth, row.right + 16) - x,
      height: Math.min(window.innerHeight, body.y + 48) - y };
  });
  await page.screenshot({ path: join(evidence, `${surface}-${width}-${theme}-${stage}.jpg`), type: "jpeg", quality: 80, clip, animations: "disabled" });
  return result;
}

export async function clickDocumentAction(page: Page, label: string) {
  const overflow = page.locator('[data-slot="document-editor-menu"] button');
  if (await overflow.isVisible()) {
    await overflow.click(); await page.getByRole("menuitem", { name: label, exact: true }).click();
  } else if (label.endsWith(" 내보내기")) {
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    await page.getByRole("menuitem", { name: label.startsWith("PDF") ? "PDF" : "Markdown", exact: true }).click();
  } else await page.getByRole("button", { name: label, exact: true }).click();
}

export async function measureHeader(page: Page, width: number, fullPage: boolean) {
  const geometry = await page.locator('[data-test-class="editable-document"] > :first-child').evaluate(row => ({
    headerWidth: row.getBoundingClientRect().width,
    menu: Boolean(row.querySelector('[data-slot="document-editor-menu"] button')?.getClientRects().length),
  }));
  console.log(JSON.stringify({ check: "document-header-width", surface: fullPage ? "drawer" : "fv", width, ...geometry }));
}

async function menuCrop(page: Page, evidence: string, name: string) {
  await page.waitForFunction(() => {
    const overlay = document.querySelector('[role="menu"], [data-slot="popover-content"]');
    return document.getAnimations().every(animation => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      const relevant = target instanceof Element && overlay && (target.contains(overlay) || overlay.contains(target));
      return !relevant || (!animation.pending && ["finished", "idle"].includes(animation.playState));
    });
  });
  const clip = await page.evaluate(() => {
    const row = document.querySelector('[data-test-class="editable-document"] > :first-child')!.getBoundingClientRect();
    const overlay = document.querySelector('[role="menu"], [data-slot="version-history"]')?.getBoundingClientRect();
    const bottom = Math.min(innerHeight, Math.max(row.bottom + 40, (overlay?.bottom ?? 0) + 16));
    const y = Math.max(0, row.top - 16, bottom - 800);
    return { x: 0, y, width: innerWidth, height: Math.min(800, bottom - y) };
  });
  await page.screenshot({ path: join(evidence, name), type: "jpeg", quality: 80, clip, animations: "disabled" });
}

export async function checkDocumentMenu(page: Page, { theme, evidence, fullPage, exports }: {
  theme: string; evidence: string; fullPage: boolean; exports: Record<string, string>[];
}) {
  const trigger = page.locator('[data-slot="document-editor-menu"] button');
  await clickDocumentAction(page, "버전 기록");
  await page.getByRole("listbox", { name: "버전 기록" }).waitFor();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement === document.querySelector('[data-slot="document-editor-menu"] button'));
  assert(await page.getByRole("listbox", { name: "버전 기록" }).isVisible(), "history survives menu close focus restoration");
  if (!fullPage && theme === "light") await menuCrop(page, evidence, "fv-390-light-versions.jpg");
  await page.keyboard.press("Escape"); await page.getByRole("listbox").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement === document.querySelector('[data-slot="document-editor-menu"] button'));
  for (const key of ["Enter", "Space"]) {
    await trigger.focus(); await page.keyboard.press(key); await page.getByRole("menu").waitFor();
    assert.deepEqual(await page.getByRole("menuitem").allTextContents().then(items => items.map(item => item.trim())), ["버전 기록", "원래 대화", "Markdown으로 내보내기", "PDF로 내보내기"]);
    if (!fullPage && key === "Enter") await menuCrop(page, evidence, `fv-390-${theme}-menu.jpg`);
    await page.keyboard.press("Escape"); await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-slot="document-editor-menu"] button'));
  }
  // Shift+Tab then Tab reaches the trigger through the real keyboard order.
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  assert(await trigger.evaluate(node => node === document.activeElement));
  if (!fullPage && theme === "light") await menuCrop(page, evidence, "fv-390-light-focus.jpg");
  await page.evaluate(() => { window.butlerApp = { exportDocument: (window as unknown as { captureExport: (value: unknown) => Promise<void> }).captureExport } as typeof window.butlerApp; });
  for (const [label, format] of [["Markdown으로 내보내기", "markdown"], ["PDF로 내보내기", "pdf"]]) {
    const count = exports.length;
    await clickDocumentAction(page, label!);
    await page.waitForFunction(() => document.querySelector('[role="menu"]') === null);
    // The exposed callback resolves after the complete export payload arrives.
    await page.waitForFunction(format => (window as unknown as { lastExport?: string }).lastExport === format, format);
    assert.equal(exports.length, count + 1); assert.equal(exports.at(-1)?.format, format);
    assert(exports.at(-1)!.content.includes("data:image/svg+xml;base64,"));
    if (format === "pdf") assert(exports.at(-1)!.content.includes("data-document-read-only"));
  }
  await page.evaluate(() => { delete window.butlerApp; });
  await clickDocumentAction(page, "원래 대화");
  assert.equal(new URL(page.url()).searchParams.get("doc"), null);
  const session = await page.evaluate(async () => { const path = "/src/app/store.ts"; return (await import(/* @vite-ignore */ path)).useButlerStore.getState().activeChatId; });
  assert.equal(session, "butler-client");
}
