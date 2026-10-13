// test-category: security
import { expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { persistedBrowserShell } from "./browserShellPersistence";

test("persisted shell contains preferences only, including when runtime media is present", () => {
  let saved = "";
  const storage = createJSONStorage(() => ({
    getItem: () => null, removeItem: () => {}, setItem: (_key, value) => { saved = value; },
  }));
  const state = { chatWidth: 400, conversations: { general: { open: true, lastTab: "t1", frame: "private pixels" } },
    frames: { t1: new Uint8Array([1, 2, 3]) }, bitmap: "private pixels" };
  const store = createStore(persist(() => state, { name: "butler-browser-shell", storage, partialize: persistedBrowserShell }));
  store.setState({ chatWidth: 440 });
  expect(JSON.parse(saved).state).toEqual({ chatWidth: 440, conversations: { general: { open: true, lastTab: "t1" } } });
  expect(saved).not.toMatch(/frame|bitmap|bytes|private pixels/iu);
});
