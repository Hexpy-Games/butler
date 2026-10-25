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
  await page.goto(`${base}?visual=components&theme=light&locale=ko`);
  await page.evaluate(async id => {
    const path = "/document-host-harness";
    (await import(/* @vite-ignore */ path)).render(id);
  }, id);
  const close = page.getByRole("button", { name: "Host close", exact: true });
  await close.waitFor();
  const buttons = page.locator('[data-test-class="editable-document"] > :first-child button');
  assert.deepEqual(await buttons.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), ["버전 기록", "원래 대화", "내보내기", "Host close"]);
  const rows = await buttons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  assert(rows.every(y => Math.abs(y - rows[0]!) < 1), JSON.stringify(rows));
  await close.focus(); await page.keyboard.press("Enter");
  await close.waitFor({ state: "hidden" });
}

export async function measureDocumentLayout(page: Page) {
  return page.locator('[data-test-class="editable-document"]').evaluate(node => {
    const root = node.querySelector('[data-document-id]')!;
    const column = node.parentElement!;
    const inner = column.parentElement!, outer = inner.parentElement!;
    const style = (element: Element) => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, border: css.borderWidth, shadow: css.boxShadow };
    };
    const wrappers = [];
    for (let element = root.parentElement; element && element !== outer.parentElement; element = element.parentElement) wrappers.push(style(element));
    return { inset: parseFloat(getComputedStyle(inner).paddingLeft) + parseFloat(getComputedStyle(outer).paddingLeft),
      maxWidth: getComputedStyle(column).maxWidth, bodyWidth: root.getBoundingClientRect().width,
      columnWidth: column.getBoundingClientRect().width, wrappers };
  });
}
export function assertDocumentLayout(layout: Awaited<ReturnType<typeof measureDocumentLayout>>, width: number) {
  assert.equal(layout.inset, width === 1440 ? 48 : 20);
  assert.equal(layout.maxWidth, "760px");
  assert(layout.bodyWidth <= 760 && layout.bodyWidth === layout.columnWidth, JSON.stringify(layout));
  assert(layout.wrappers.every(css => css.background === "rgba(0, 0, 0, 0)" && parseFloat(css.border) === 0 && css.shadow === "none"), JSON.stringify(layout));
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
