import { afterAll, afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { confirmAction, useConfirmationStore } from "./confirmation.ts";
import { useSettingsUIStore } from "../stores/settingsUIStore.ts";

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;
const dom = new JSDOM("<!doctype html><button>Open</button>");
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
});

afterEach(() => {
  useConfirmationStore.getState().pending?.resolve(false);
  useSettingsUIStore.setState({ modelRouteLeaveGuard: null });
});

test("confirmation waits for a decision and preserves cancel versus accept", async () => {
  const opener = document.querySelector("button")!;
  opener.focus();
  let completed = false;
  const result = confirmAction("Delete this item?").then((value) => {
    completed = true;
    return value;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(useConfirmationStore.getState().pending?.returnFocus).toBe(opener);
  useConfirmationStore.getState().pending?.resolve(false);
  expect(await result).toBe(false);
  const accepted = confirmAction("Continue?");
  useConfirmationStore.getState().pending?.resolve(true);
  expect(await accepted).toBe(true);
  expect(useConfirmationStore.getState().pending).toBeNull();
});

test("a replacement prompt cancels the former action, never implicitly accepts", async () => {
  const former = confirmAction("Former action");
  const next = confirmAction("Next action");
  expect(await former).toBe(false);
  expect(useConfirmationStore.getState().pending?.message).toBe("Next action");
  useConfirmationStore.getState().pending?.resolve(true);
  expect(await next).toBe(true);
});

test("settings navigation waits for the unsaved-change dialog before leaving", async () => {
  useSettingsUIStore.setState({
    activeSection: "models",
    modelRoute: { page: "edit", modelRef: "test-model" },
    modelRouteLeaveGuard: () => confirmAction("Discard changes?"),
  });
  const refused = useSettingsUIStore.getState().setActiveSection("general");
  expect(useSettingsUIStore.getState().activeSection).toBe("models");
  useConfirmationStore.getState().pending?.resolve(false);
  expect(await refused).toBe(false);
  expect(useSettingsUIStore.getState().modelRoute.page).toBe("edit");
  const accepted = useSettingsUIStore.getState().setActiveSection("general");
  useConfirmationStore.getState().pending?.resolve(true);
  expect(await accepted).toBe(true);
  expect(useSettingsUIStore.getState().activeSection).toBe("general");
  expect(useSettingsUIStore.getState().modelRoute.page).toBe("root");
});

afterAll(() => {
  Object.assign(globalThis, { document: originalDocument, HTMLElement: originalHTMLElement });
  dom.window.close();
});
