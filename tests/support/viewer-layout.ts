import type { Page } from "playwright";

export async function gotoViewer(page: Page, url: string, options: Parameters<Page["goto"]>[1] = {}): Promise<void> {
  await page.goto(url, { ...options, waitUntil: "domcontentloaded" });
  await page.locator("[data-ds-viewer]").waitFor({ state: "visible" });
  await waitForViewerLayout(page);
}

/** Device specimens use srcdoc frames; their lifecycle need not become network-idle. */
export async function waitForViewerLayout(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLIFrameElement>("iframe[srcdoc]")]
    .every((frame) => frame.contentDocument?.body?.dataset.ready !== undefined
      && frame.contentDocument.body.childElementCount > 0));
  await page.evaluate(async () => {
    const documents = [document, ...[...document.querySelectorAll<HTMLIFrameElement>("iframe[srcdoc]")]
      .map((frame) => frame.contentDocument).filter((doc): doc is Document => doc !== null)];
    await Promise.all(documents.map(async (doc) => {
      // Mirrored stylesheets must load before FontFaceSet observes their fonts.
      await Promise.all([...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .map((sheet) => sheet.sheet ? Promise.resolve() : new Promise<void>((resolve, reject) => {
          sheet.addEventListener("load", () => resolve(), { once: true });
          sheet.addEventListener("error", () => reject(new Error("viewer stylesheet failed")), { once: true });
        })));
      doc.body.getBoundingClientRect();
      await doc.fonts.ready;
    }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}
