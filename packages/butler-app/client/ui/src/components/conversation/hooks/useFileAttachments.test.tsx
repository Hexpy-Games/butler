import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { useFileAttachments } from "./useFileAttachments";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { ATTACHMENT_MAX_BYTES } from "../conversationUtils";

test("mixed file selection preserves success and separates localized size/upload failures", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true });
  const uploads: string[] = [];
  dom.window.butlerApp = { uploadMessageFile: async ({ name }: { name: string }) => {
    uploads.push(name);
    if (name === "failed.pdf") throw new Error("SECRET transport detail");
    return { file: { file_id: "accepted", safe_name: name, kind: "generic", url: "/message-files/accepted" } };
  } };
  setAppCopyLanguage("ko-KR");
  let state!: ReturnType<typeof useFileAttachments>;
  function Harness() { state = useFileAttachments("draft:chat"); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<Harness />));
    const files = [new File(["ok"], "accepted.pdf"), new File(["bad"], "failed.pdf"),
      new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "large.pdf")];
    await act(async () => state.addFiles(files as unknown as FileList));
    expect(uploads).toEqual(["accepted.pdf", "failed.pdf"]);
    expect(state.attachments.map((item) => item.file.safe_name)).toEqual(["accepted.pdf"]);
    expect(state.uploadingCount).toBe(0);
    const notices = JSON.stringify(toast.getHistory());
    expect(notices).toContain("파일을 첨부하지 못했습니다");
    expect(notices).toContain("파일이 첨부 가능한 크기를 초과");
    expect(notices).toContain("large.pdf");
    expect(notices).toContain("10.0 MB");
    expect(notices).not.toContain("SECRET");
  } finally {
    await act(async () => root.unmount());
    setAppCopyLanguage("en-US");
    keys.forEach((key, index) => { const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    dom.window.close();
  }
});
