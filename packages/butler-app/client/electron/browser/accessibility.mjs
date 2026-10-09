/** Optional AX-name gap, joined to the exact existing ref in its owned world. */
export async function accessibleName(tab, frame, ref) {
  const prefix = `${frame.sessionId || "root"}:`;
  const key = [...tab.contextIds].find(([key, value]) => key.startsWith(prefix) && value.frameId === frame.id && value.name === tab.contextNames.get(frame.id))?.[0];
  const contextId = frame.contextId ?? (key ? Number(key.slice(prefix.length)) : undefined);
  if (contextId === undefined) return;
  let objectId;
  try {
    const evaluated = await frame.api.sendCommand("Runtime.evaluate", { contextId,
      expression: `globalThis.__butlerObservation?.refs.get(${JSON.stringify(ref)})?.deref()`, returnByValue: false });
    objectId = evaluated.result.objectId;
    if (!objectId) return;
    const { node } = await frame.api.sendCommand("DOM.describeNode", { objectId });
    const { nodes } = await frame.api.sendCommand("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
    const name = nodes.find(candidate => candidate.backendDOMNodeId === node.backendNodeId && !candidate.ignored)?.name?.value;
    if (typeof name !== "string" || !name.trim()) return;
    await frame.api.sendCommand("Runtime.callFunctionOn", { objectId, arguments: [{ value: name }],
      functionDeclaration: "function(name){const state=globalThis.__butlerObservation;if(state)(state.accessibleNames??=new WeakMap()).set(this,name)}" });
    return name;
  } finally {
    if (objectId) await frame.api.sendCommand("Runtime.releaseObject", { objectId });
  }
}

export async function nameObservation(tab, frame, result) {
  for (const node of result.nodes) {
    if ((!node.actionable && node.value === undefined) || node.secure || !/^icon \d+×\d+ at /u.test(node.name)) continue;
    const name = await accessibleName(tab, frame, node.ref);
    if (!name) continue;
    result.text = result.text.replace(`${node.role} ${JSON.stringify(node.name)} [${node.ref}]`, `${node.role} ${JSON.stringify(name)} [${node.ref}]`);
    node.name = name; node.name_source = "accessibility";
  }
}
