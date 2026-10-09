import type { Page } from "playwright";
import type { PerceptionSnapshot, SnapshotNode, SnapshotProvider } from "./contracts";
import { closedRoots } from "../../packages/butler-app/client/electron/browser/closed-roots.mjs";
import { perceptionSource } from "../../packages/butler-app/client/electron/browser/page/snapshot.mjs";

/** Uses the product walker, without gold labels or fixture-specific filters. */
export class HitTestedProvider implements SnapshotProvider {
  arm = "A1";
  constructor(private fullGrid = false) {}
  async snapshot(page: Page): Promise<PerceptionSnapshot> {
    const nodes: SnapshotNode[] = [], text: string[] = [];
    let scriptMs = 0, gridSampleMs = 0;
    for (const [index, frame] of page.frames().entries()) {
      const session = await page.context().newCDPSession(page);
      const { frameTree } = await session.send("Page.getFrameTree");
      const find = (tree: any): string | undefined => tree.frame.url === frame.url() ? tree.frame.id : tree.childFrames?.map(find).find(Boolean);
      const frameId = find(frameTree);
      const context = frameId ? await closedRoots({ sendCommand: (method, params) => session.send(method as Parameters<typeof session.send>[0], params) }, frameId, frameTree.frame.id) : undefined;
      const code = perceptionSource({ obs: "eval", epoch: 1, prefix: `f${index}-`, full_grid: this.fullGrid });
      const response = context ? await session.send("Runtime.evaluate", { expression: code, contextId: context.contextId, returnByValue: true }) : undefined;
      if(response?.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      const result = (response ? response.result.value : await frame.evaluate(code)) as {
        text: string; nodes: Array<SnapshotNode & { coveredTargetId?: string }>; scriptMs: number; gridSampleMs: number;
      };
      await session.detach();
      for (const node of result.nodes) nodes.push({ ...node, coveredBy: node.coveredTargetId ?? node.coveredBy });
      text.push(result.text); scriptMs += result.scriptMs; gridSampleMs += result.gridSampleMs;
    }
    return { text: text.join("\n"), nodes, scriptMs, gridSampleMs };
  }
}
