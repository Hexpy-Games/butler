import { strict as assert } from "node:assert";
import type { BrowserContext } from "playwright";
import { perceptionSource } from "../../packages/butler-app/client/electron/browser/page/snapshot.mjs";

/** A reused element index must never reuse observed page data or detached roots. */
export async function dynamicPerceptionCheck(context: BrowserContext) {
  const page = await context.newPage();
  try {
    await page.setContent('<button id="old">Original</button><div id="role">Role target</div><section id="host"></section><label for="field">Original label</label><input id="field">');
    const identities = new Map<string, string>();
    const observe = async (ids: string[], names?: string[]) => {
      const result = await page.evaluate(perceptionSource({ obs: crypto.randomUUID(), epoch: 1, prefix: "f0-" })) as {nodes: Array<{targetId: string; name: string; ref: string}>};
      assert.deepEqual(result.nodes.map((node: {targetId: string}) => node.targetId), ids);
      for (const node of result.nodes) {
        const previous = identities.get(node.targetId);
        if (previous) assert.equal(node.ref, previous, "DOM insertions must not renumber existing targets");
        else { assert.ok(![...identities.values()].includes(node.ref), "new elements must not reuse another target ref"); identities.set(node.targetId, node.ref); }
      }
      if (names) assert.deepEqual(result.nodes.map((node: {name: string}) => node.name), names);
    };
    await observe(["old", "field"], ["Original", "Original label"]);
    await page.evaluate(() => {
      document.getElementById("old")!.textContent = "Latest";
      document.querySelector("label")!.textContent = "Latest label";
    });
    await observe(["old", "field"], ["Latest", "Latest label"]);
    await page.evaluate(() => { document.getElementById("old")!.style.opacity = "0"; });
    await observe(["field"], ["Latest label"]);
    await page.evaluate(() => {
      document.getElementById("old")!.style.opacity = "1";
      document.getElementById("role")!.setAttribute("role", "button");
      const button = document.createElement("button"); button.id = "added"; button.textContent = "Added"; document.body.append(button);
    });
    await observe(["old", "role", "field", "added"]);
    await page.evaluate(() => {
      document.getElementById("old")!.remove();
      document.getElementById("host")!.attachShadow({mode: "open"}).innerHTML = '<button id="shadow">Shadow latest</button>';
    });
    await observe(["role", "shadow", "field", "added"]);
    await page.evaluate(() => { document.getElementById("host")!.remove(); });
    await observe(["role", "field", "added"]);
    assert.equal(await page.evaluate("globalThis.__butlerPerceptionImplementation.indexes.size"), 1, "removed root index and observer released");
  } finally { await page.close(); }
}
