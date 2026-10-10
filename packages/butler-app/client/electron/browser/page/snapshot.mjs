import * as helpers from "./perception.mjs";
import { readingText } from "./text.mjs";
import { resolveRef, selectValue } from "./refs.mjs";
import { elementChanges, rootIndex, collect, snapshot } from "./walk.mjs";

// Keep executable functions warm in the isolated world; page data and refs are
// rebuilt on every call. A source change replaces the implementation atomically.
const implementation = `${Object.values(helpers).map(fn => fn.toString()).join("\n")}\n${elementChanges.toString()}\n${rootIndex.toString()}\n${collect.toString()}\n${readingText.toString()}\n${snapshot.toString()}\n${resolveRef.toString()}\n${selectValue.toString()}`;
export function perceptionSource(options) {
  return `(() => {
    const source = ${JSON.stringify(implementation)};
    if (globalThis.__butlerPerceptionImplementation?.source !== source) {
      ${implementation}
      Object.assign(globalThis, { ${Object.keys(helpers).join(", ")} });
      for (const index of globalThis.__butlerPerceptionImplementation?.indexes?.values() ?? []) index.observer.disconnect();
      globalThis.__butlerPerceptionImplementation = { source, snapshot, indexes: new Map(), targetIds: new WeakMap(), nextTargetId: 0 };
    }
    return globalThis.__butlerPerceptionImplementation.snapshot(${JSON.stringify(options)});
  })()`;
}
export const resolveSource = input => `(${resolveRef.toString()})(${JSON.stringify(input)})`;
export const selectSource = input => `(${selectValue.toString()})(${JSON.stringify(input)})`;
