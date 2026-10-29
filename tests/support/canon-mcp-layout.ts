// test-category: format-pin
import { strict as assert } from "node:assert";
import type { Locator } from "playwright";

export async function assertNeutralAgentMark(surface: Locator) {
  const badge = surface.locator('[data-slot="avatar-badge"]');
  const mark = badge.locator('svg[data-test-class="canon-agent-mark"][aria-hidden="true"]');
  await mark.first().waitFor();
  assert.equal(await mark.count(), await badge.count(), "Every badge has a neutral tool mark");
  assert.equal(await badge.locator("[data-name]").count(), 0, "Client names cannot select a brand logo");
  const shapes = await mark.evaluateAll(elements => elements.map(element => element.innerHTML));
  assert(shapes.every(shape => shape === shapes[0]), "All tool marks have the same glyph");
  return shapes[0]!;
}

export async function assertTrustLayout(dialog: Locator, capabilities: string[], requestedPermissions: string) {
  await dialog.page().evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => animation.timeline instanceof DocumentTimeline
      && animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  const title = await dialog.locator('[data-slot="dialog-title"]').boundingBox(); assert(title);
  const facts = dialog.locator('[data-test-class="key-value-row"]');
  assert.equal(await facts.count(), 3);
  const permissionLabel = facts.last().locator('[data-test-class="key-value-label"]');
  await permissionLabel.getByText(requestedPermissions, { exact: true }).waitFor();
  const labelStyles = await facts.locator('[data-test-class="key-value-label"]').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.fontWeight, style.color, element.getBoundingClientRect().x];
  }));
  assert.deepEqual(labelStyles[2], labelStyles[0], "Permission label matches the fact labels");
  const permissionBox = await permissionLabel.boundingBox(); assert(permissionBox);
  for (const fact of [facts.nth(0), facts.nth(1)]) {
    const { label, value } = await fact.evaluate(element => ({
      label: element.querySelector('[data-test-class="key-value-label"]')?.getBoundingClientRect(),
      value: element.querySelector('[data-test-class="key-value-description"] > *')?.getBoundingClientRect(),
    }));
    assert(label && value);
    assert(value.y >= label.y + label.height, `Value sits below its label: ${JSON.stringify({ label, value })}`);
    assert(Math.abs(value.x - label.x) <= 1, "Fact label and value share their left edge");
    assert(Math.abs(label.x - title.x) <= 1, "Facts align with the dialog title");
  }
  for (const capability of capabilities) {
    const row = await dialog.getByText(capability, { exact: true }).boundingBox(); assert(row);
    assert(Math.abs(row.x - title.x) <= 1, "Capabilities align with the dialog title");
    assert(row.y >= permissionBox.y + permissionBox.height, "Permissions follow their label");
  }
}

export async function assertActivityTimes(activity: Locator) {
  const titles = activity.locator('[data-slot="activity-feed-title"]');
  assert(await titles.count() > 1, "Compare multiple activity times");
  const edges = [];
  for (const title of await titles.all()) {
    const time = title.locator("..").locator(":scope > :last-child");
    const box = await time.boundingBox(); assert(box);
    assert(await time.textContent(), "Each activity row has a time");
    edges.push(box.x + box.width);
  }
  const spread = Math.max(...edges) - Math.min(...edges);
  console.log(JSON.stringify({ check: "activity-time-alignment", rows: edges.length, rightEdgeSpreadPx: spread }));
  assert(spread <= 1, "Every activity time shares the same right edge within 1px");
  const icons = activity.locator('[data-slot="activity-feed-icon"] svg[aria-hidden="true"]');
  assert.equal(await icons.count(), await titles.count(), "Every activity kind has a decorative icon");
}
