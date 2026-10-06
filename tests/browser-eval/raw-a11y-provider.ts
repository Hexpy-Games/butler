import type { CDPSession, Page } from "playwright";
import type { PerceptionSnapshot, SnapshotNode, SnapshotProvider } from "./contracts.ts";

const roles = new Set(["button", "link", "textbox", "checkbox", "combobox", "slider", "spinbutton", "menuitem"]);

async function collectFrame(session: CDPSession, url: string, nodes: SnapshotNode[]) {
  const { frameTree } = await session.send("Page.getFrameTree");
  function find(tree: any): string | undefined {
    if (tree.frame.url === url) return tree.frame.id;
    for (const child of tree.childFrames ?? []) { const id = find(child); if (id) return id; }
  }
  const frameId = find(frameTree);
  if (!frameId) throw new Error(`Frame not found: ${url}`);
  const result = await session.send("Accessibility.getFullAXTree", { frameId });
  for (const node of result.nodes) {
    let targetId: string | undefined;
    if (node.backendDOMNodeId) {
      const { node: dom } = await session.send("DOM.describeNode", { backendNodeId: node.backendDOMNodeId });
      const attrs = dom.attributes ?? [];
      const index = attrs.indexOf("id");
      if (index >= 0) targetId = attrs[index + 1];
    }
    nodes.push({ ref: `${frameId}:${node.nodeId}`, targetId, frameOrigin: new URL(url).origin,
      actionable: !node.ignored && roles.has(String(node.role?.value)) });
  }
  return result;
}

/** A0 preserves Chromium AX nodes; DOM is used only to join backend IDs to fixture IDs. */
export class RawA11yProvider implements SnapshotProvider {
  arm = "A0";
  async snapshot(page: Page): Promise<PerceptionSnapshot> {
    const start = performance.now();
    const nodes: SnapshotNode[] = [];
    const trees: unknown[] = [];
    // A per-frame session works for both same-process frames and normal Chromium OOPIFs.
    for (const frame of page.frames()) {
      let session: CDPSession;
      try { session = await page.context().newCDPSession(frame); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("part of the parent frame")) throw error;
        session = await page.context().newCDPSession(page);
      }
      try { trees.push(await collectFrame(session, frame.url(), nodes)); }
      finally { await session.detach(); }
    }
    return { text: JSON.stringify(trees), nodes, scriptMs: performance.now() - start };
  }
}
