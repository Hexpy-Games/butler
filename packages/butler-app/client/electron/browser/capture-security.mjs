import { frameWorlds, evaluateWorld, framePoint } from "./frame-worlds.mjs";
import { perceptionSource } from "./page/snapshot.mjs";

/** Re-read secure rectangles without replacing the observation's model refs. */
export async function secureBoxes(tab) {
  const boxes = [], scale = tab.bounds?.scale ?? 1;
  for (const frame of await frameWorlds(tab, { immediate: true })) {
    const source = perceptionSource({ obs: "capture-security", epoch: tab.epoch,
      prefix: "secure-", secureKeypads: tab.policy?.secure_keypads ?? [] });
    const nodes = await evaluateWorld(frame, `(()=>{
      const previous=globalThis.__butlerObservation;
      try { return ${source}.nodes.filter(node=>node.secure && node.rect); }
      finally { globalThis.__butlerObservation=previous; }
    })()`);
    for (const node of nodes) {
      const point = await framePoint(frame, node.rect);
      boxes.push({ secure: true, rect: { x: point.x * scale, y: point.y * scale,
        width: node.rect.width * scale, height: node.rect.height * scale } });
    }
  }
  return boxes;
}

/** Electron WebContents scripts wait for load completion; capture privacy cannot. */
export async function captureViewport(tab) {
  await tab.debuggerReady;
  const api = tab.view.webContents.debugger;
  const { frameTree } = await api.sendCommand("Page.getFrameTree");
  const { executionContextId } = await api.sendCommand("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "butler-capture-viewport",
  });
  // Layout metrics exclude scrollbars; masking needs the whole captured viewport.
  const { result, exceptionDetails } = await api.sendCommand("Runtime.evaluate", {
    contextId: executionContextId, expression: "({width:innerWidth,height:innerHeight})", returnByValue: true,
  });
  if (exceptionDetails || !result.value?.width || !result.value?.height) throw new Error("viewport_unavailable");
  return result.value;
}
