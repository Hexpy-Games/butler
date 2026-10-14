// Optional debugger gap 5: expose closed roots only inside the isolated observation world.
export async function closedRoots(session, frameId, _mainFrameId, snapshot, skipEmpty = false) {
  // DOMSnapshot uses shared strings and sparse arrays instead of serializing every
  // DOM node's attributes repeatedly. It still visits the entire current document.
  snapshot ??= await session.sendCommand("DOMSnapshot.captureSnapshot", { computedStyles: [] });
  const document = snapshot.documents.find(document => snapshot.strings[document.frameId] === frameId);
  const roots = [];
  // Chromium's flat snapshot labels descendants and omits ShadowRoot objects.
  // Acquire the pierced tree only when that snapshot detects a closed root.
  if ((document?.nodes.shadowRootType?.value ?? []).some(value=>snapshot.strings[value]==="closed")) {
    snapshot.tree ??= (await session.sendCommand("DOM.getDocument",{depth:-1,pierce:true})).root;
    function find(node) {
      if (node.nodeName==="#document" && (node.frameId===frameId || frameId===_mainFrameId && node===snapshot.tree)) return node;
      for(const child of [...node.children ?? [],...node.contentDocument?[node.contentDocument]:[]]) {const found=find(child);if(found)return found;}
    }
    function visit(node) {
      if(node.shadowRootType==="closed") roots.push(node.backendNodeId);
      for(const child of [...node.children ?? [],...node.shadowRoots ?? []]) visit(child);
    }
    const tree=find(snapshot.tree);if(tree)visit(tree);
  }
  if (skipEmpty && roots.length === 0) return {contextId:null,hasClosedRoots:false};
  const { executionContextId } = await session.sendCommand("Page.createIsolatedWorld", { frameId, worldName: "butler-browser" });
  await session.sendCommand("Runtime.evaluate", { expression: "globalThis.__butlerClosedRoots = []", contextId: executionContextId });
  for (const backendNodeId of roots) {
    const { object } = await session.sendCommand("DOM.resolveNode", { backendNodeId, executionContextId });
    if (object.objectId) await session.sendCommand("Runtime.callFunctionOn", { objectId: object.objectId,
      functionDeclaration: "function(){ globalThis.__butlerClosedRoots.push(this); }" });
    if (object.objectId) await session.sendCommand("Runtime.releaseObject", { objectId: object.objectId });
  }
  return { contextId: executionContextId, hasClosedRoots: roots.length > 0 };
}
