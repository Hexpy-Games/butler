type EditGuard = { leave: () => Promise<boolean> };
let editor: EditGuard | undefined;

/** The mounted inline editor owns the decision; user navigation awaits it. */
export function registerCanonEditor(guard: EditGuard): () => void {
  editor = guard;
  return () => { if (editor === guard) editor = undefined; };
}

export function leaveCanonEditor(): true | Promise<boolean> {
  return editor?.leave() ?? true;
}
