import { expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { setAppCopyLanguage } from "@/app/copy";
import { useOrganization } from "@/app/space/organization";
import { useButlerStore } from "@/app/store";
import { useOrganizationNotice } from "./useOrganizationNotice";

test("only automatic grouping is announced, with deduplication and revision-bound undo", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "requestAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  const originalApp = useButlerStore.getState();
  const originalOrganization = useOrganization.getState();
  const commands: unknown[] = [];
  const messages = spyOn(toast, "message");
  const dismiss = spyOn(toast, "dismiss");
  const space = { ...originalApp.navigation.space, revision: 10,
    smartNotice: { title: "식혜", undoToken: "smart-test", revision: 10 } };
  useButlerStore.setState({ navigation: { ...originalApp.navigation, space } });
  useOrganization.setState({ undoToken: null, undoRevision: null, pending: false,
    mutate: async (intent) => { commands.push(intent); return true; } });
  setAppCopyLanguage("ko");
  function Harness() { useOrganizationNotice(); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const lastToast = () => {
    const item = toast.getHistory().filter((entry) => String(entry.id).startsWith("space-organization:")).at(-1);
    if (!item || !("title" in item)) throw new Error("Missing organization toast");
    return item;
  };
  try {
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    expect(lastToast().title).toBe("식혜 그룹으로 정리했습니다.");
    expect(lastToast().duration).toBe(8_000);
    expect(messages).toHaveBeenCalledTimes(1);
    await act(async () => useButlerStore.setState({ navigation: { ...originalApp.navigation, space: { ...space } } }));
    expect(messages).toHaveBeenCalledTimes(1);
    const action = lastToast().action;
    if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Missing undo action");
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } } as React.MouseEvent<HTMLButtonElement>;
    useOrganization.setState({ pending: true });
    action.onClick(event);
    expect(prevented).toBe(true);
    expect(commands).toHaveLength(0);
    useOrganization.setState({ pending: false });
    action.onClick(event);
    expect(commands).toEqual([{ action: "undo", undoToken: "smart-test" }]);
    await act(async () => useButlerStore.setState({ navigation: { ...originalApp.navigation,
      space: { ...space, revision: 11, smartNotice: undefined } } }));
    expect(dismiss).toHaveBeenCalledWith("space-organization:smart-test");
    action.onClick(event);
    expect(commands).toHaveLength(1);
    setAppCopyLanguage("en");
    await act(async () => useOrganization.setState({ undoToken: "manual-test", undoRevision: 11 }));
    expect(messages).toHaveBeenCalledTimes(1);
    await act(async () => useButlerStore.setState({ navigation: { ...originalApp.navigation,
      space: { ...space, revision: 12, smartNotice: undefined } } }));
    await act(async () => useOrganization.setState({ undoToken: "manual-move", undoRevision: 12 }));
    expect(messages).toHaveBeenCalledTimes(1);
    // A later automatic grouping still announces even after intervening manual changes.
    await act(async () => useButlerStore.setState({ navigation: { ...originalApp.navigation,
      space: { ...space, revision: 13, smartNotice: { title: "Travel", undoToken: "smart-next", revision: 13 } } } }));
    expect(messages).toHaveBeenCalledTimes(2);
    expect(lastToast().title).toBe("Organized into Travel.");
  } finally {
    await act(async () => root.unmount());
    messages.mockRestore();
    dismiss.mockRestore();
    toast.dismiss("space-organization:smart-next");
    useButlerStore.setState(originalApp);
    useOrganization.setState(originalOrganization);
    setAppCopyLanguage("en-US");
    keys.forEach((key, index) => { const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});
