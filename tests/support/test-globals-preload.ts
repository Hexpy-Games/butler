/// <reference types="bun" />
// Shared bun test preload (wired via bunfig.toml [test].preload).
// Many DOM tests install jsdom globals and later `delete` them. When the
// deleted name is a runtime-native global (fetch, Event, CustomEvent,
// navigator, ...), later test files in the same bun process lose it.
// Snapshot the runtime globals once and put back any that a test removed
// before the next test starts. Globals a test *sets* are left alone, so
// beforeAll-installed environments keep working inside their own file.
import { beforeEach } from "bun:test";
import { join } from "node:path";

const nativeGlobals = new Map<string, PropertyDescriptor>();
for (const name of Object.getOwnPropertyNames(globalThis)) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor?.configurable) nativeGlobals.set(name, descriptor);
}

export function restoreRemovedNativeGlobals(): void {
  for (const [name, descriptor] of nativeGlobals) {
    if (!Object.prototype.hasOwnProperty.call(globalThis, name)) {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

beforeEach(restoreRemovedNativeGlobals);

// Several UI dependencies decide at *module load* whether a DOM exists
// (react-dom's canUseDOM and event-name detection, Radix/floating-ui
// layout-effect shims, Lexical's CAN_USE_DOM). Whichever test file loaded them
// first used to fix that choice for the whole bun process, so results depended
// on file order. Load them here once, inside a temporary browser-like jsdom
// window, then remove the window again: every run (one file or the whole
// suite) sees the same load-time environment, the one the app ships in.
await loadUiModulesWithBrowserGlobals();

async function loadUiModulesWithBrowserGlobals(): Promise<void> {
  const uiSource = join(import.meta.dir, "../../packages/butler-app/client/ui/src");
  let JSDOM: typeof import("jsdom").JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    return; // No UI test dependencies in this checkout.
  }
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  // Browsers have these; jsdom does not, which makes react-dom pick vendor-prefixed
  // animation/transition event names.
  const browserWindow = window as unknown as Record<string, unknown>;
  browserWindow.AnimationEvent ??= window.Event;
  browserWindow.TransitionEvent ??= window.Event;
  const names = ["window", "document", "navigator"] as const;
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, { window, document: window.document, navigator: window.navigator });
  try {
    for (const specifier of ["react-dom/client", "lexical", "@lexical/react/LexicalComposer"]) {
      try {
        await import(Bun.resolveSync(specifier, uiSource));
      } catch {
        // Optional for non-UI test runs.
      }
    }
    try {
      await import(join(uiSource, "libs/design-system/index.ts"));
    } catch {
      // Optional for non-UI test runs.
    }
  } finally {
    names.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
    window.close();
  }
}
