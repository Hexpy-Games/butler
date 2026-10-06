// Optional debugger gap 5: expose closed roots only inside the isolated observation world.
export async function closedRoots(session, frameId, mainFrameId) {
  mainFrameId ??= (await session.sendCommand("Page.getFrameTree")).frameTree.frame.id;
  const { root } = await session.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
  const roots = [];
  function documentFor(node) {
    if (node.frameId === frameId && node.nodeName === "#document") return node;
    for (const child of [...node.children ?? [], ...node.contentDocument ? [node.contentDocument] : []]) {
      const found = documentFor(child); if (found) return found;
    }
  }
  function visit(node) {
    if (node.shadowRootType === "closed") roots.push(node.backendNodeId);
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) visit(child);
  }
  const document = frameId === mainFrameId ? root : documentFor(root);
  if (!document) return undefined;
  visit(document);
  if (!roots.length) return undefined;
  const { executionContextId } = await session.sendCommand("Page.createIsolatedWorld", { frameId, worldName: "butler-browser" });
  await session.sendCommand("Runtime.evaluate", { expression: "globalThis.__butlerClosedRoots = []", contextId: executionContextId });
  for (const backendNodeId of roots) {
    const { object } = await session.sendCommand("DOM.resolveNode", { backendNodeId, executionContextId });
    if (object.objectId) await session.sendCommand("Runtime.callFunctionOn", { objectId: object.objectId,
      functionDeclaration: "function(){ globalThis.__butlerClosedRoots.push(this); }" });
    if (object.objectId) await session.sendCommand("Runtime.releaseObject", { objectId: object.objectId });
  }
  return executionContextId;
}
