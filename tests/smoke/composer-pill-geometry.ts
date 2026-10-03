import { strict as assert } from "node:assert";
import type { Locator } from "playwright";

// Behavior smoke: edge fades must reflect the actual scroll position.
export async function auditControlScroll(story: Locator) {
  const scroll = story.locator('[data-slot="composer-controls-scroll"]');
  const overflow = await scroll.evaluate((node) => node.scrollWidth - node.clientWidth);
  const states = overflow > 1 ? [0, 0.5, 1] : [0];
  const measured = [];
  for (const fraction of states) {
    await scroll.evaluate((node, fraction) => { node.scrollLeft = (node.scrollWidth - node.clientWidth) * fraction; }, fraction);
    const start = fraction === 0;
    const end = overflow <= 1 || fraction === 1;
    await scroll.page().waitForFunction(({ node, start, end }) => {
      const element = node as HTMLElement;
      return element.dataset.atStart === String(start) && element.dataset.atEnd === String(end);
    }, { node: await scroll.elementHandle(), start, end }, { timeout: 5000 });
    const fades = await scroll.evaluate((node) => {
      const css = getComputedStyle(node);
      return { start: parseFloat(css.getPropertyValue("--scroll-fade-start")),
        end: parseFloat(css.getPropertyValue("--scroll-fade-end")), mask: css.maskImage };
    });
    assert.equal(fades.start > 0, !start, "left fade follows clipped content");
    assert.equal(fades.end > 0, !end, "right fade follows clipped content");
    assert.notEqual(fades.mask, "none", "DS mask is applied");
    measured.push({ fraction, ...fades });
  }
  const grouping = await scroll.evaluate((node) => {
    const box = (name: string) => node.querySelector(`[data-test-class="${name}"]`)!.getBoundingClientRect();
    const left = box("composer-plan-mode-badge"), spacer = box("composer-toolbar-spacer");
    const right = box("context-donut-button"), model = box("model-button");
    return { gap: right.left - left.right, spacer: spacer.width,
      ordered: left.right <= spacer.left && spacer.right <= right.left && right.right <= model.left };
  });
  assert(grouping.ordered && grouping.spacer > 0, "left group / spacer / right group retained");
  if (overflow <= 1) assert(grouping.spacer > 20, "spacer fills available width");
  await scroll.evaluate((node) => { node.scrollLeft = 0; });
  return { overflow, grouping, fades: measured.map(({ fraction, start, end }) => ({ fraction, start, end })) };
}

export async function auditContextPill(story: Locator) {
  const metrics = await story.evaluate((node) => {
    const button = node.querySelector('[data-test-class="context-donut-button"]')!;
    const peer = node.querySelector('[data-test-class="attachment-button"]')!;
    const css = getComputedStyle(button), peerCss = getComputedStyle(peer);
    const ring = button.querySelector("svg")!, circle = ring.querySelector("circle")!;
    return { height: button.getBoundingClientRect().height, peerHeight: peer.getBoundingClientRect().height,
      padding: css.padding, peerPadding: peerCss.padding, background: css.backgroundColor,
      peerBackground: peerCss.backgroundColor, border: css.border, peerBorder: peerCss.border,
      ring: [ring.getBoundingClientRect().width, ring.getBoundingClientRect().height],
      viewBox: ring.getAttribute("viewBox"), radius: circle.getAttribute("r") };
  });
  assert.equal(metrics.height, metrics.peerHeight, "same pill height/hit area");
  assert.equal(metrics.padding, metrics.peerPadding, "same pill padding");
  assert.equal(metrics.background, metrics.peerBackground, "same glass background");
  assert.equal(metrics.border, metrics.peerBorder, "same glass border");
  assert.deepEqual(metrics.ring, [18, 18], "ring size unchanged");
  assert.equal(metrics.viewBox, "0 0 20 20");
  assert.equal(metrics.radius, "8");
  return metrics;
}
