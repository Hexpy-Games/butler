/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PASTE_COMMAND } from "lexical";
import { toast } from "sonner";
import { EMPTY_NAVIGATION, EMPTY_SETTINGS } from "@/app/constants.ts";
import { appCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppModelSummary, MessageFileRef } from "@/app/types.ts";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerFileInput } from "./ComposerFileInput";
import { ComposerSendAction } from "./ComposerSendAction";
import { composerImagePolicy, type ComposerImagePolicy } from "./composerImagePolicy";
import { useComposerStore } from "./composerStore";
import { registerComposerClipboard } from "./editor/clipboard";
import { useComposerFileDrop } from "./hooks/useComposerFileDrop";
import { useComposerState } from "./hooks/useComposerState";
import { useFileAttachments, type ComposerAttachment } from "./hooks/useFileAttachments";

const initialButlerState = useButlerStore.getState();
const initialComposerState = useComposerStore.getState();
const GLOBAL_KEYS = ["window", "document", "navigator", "Element", "HTMLElement", "HTMLButtonElement",
  "HTMLInputElement", "SVGElement", "Node", "MutationObserver", "ResizeObserver", "getComputedStyle",
  "DocumentFragment", "Event", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = GLOBAL_KEYS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
let root: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useButlerStore.setState(initialButlerState);
  useComposerStore.setState(initialComposerState);
  setAppCopyLanguage("en-US");
  GLOBAL_KEYS.forEach((key, index) => {
    const descriptor = savedGlobals[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
  dom?.window.close();
  dom = undefined;
});

function model(fields: Partial<AppModelSummary> = {}): AppModelSummary {
  return {
    provider_id: "openai", provider_label: "OpenAI", model_id: "m", model_ref: "openai/m",
    display_name: "M", status: "available", default_reasoning_effort: "medium",
    reasoning_efforts: ["medium"], token_estimator: "tiktoken", runtime_supported: true, ...fields,
  };
}
const TEXT_ONLY = model({ model_ref: "openai/text", image_input_support: "unsupported" });
const UNKNOWN = model({ model_ref: "openai/unknown", image_input_support: "unknown" });
const VISION = model({ model_ref: "openai/vision", image_input_support: "supported",
  image_accepted_mime_types: ["image/png", "image/jpeg"], image_max_inline_bytes: 100 });

function mount(): HTMLElement {
  dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement,
    SVGElement: dom.window.SVGElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    DocumentFragment: dom.window.DocumentFragment, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root")!;
  root = createRoot(container);
  return container;
}

function files(...entries: Array<[string, string, number?]>): FileList {
  const list = entries.map(([name, type, size = 4]) => new dom!.window.File([new Uint8Array(size)], name, { type }));
  return Object.assign([...list], { item: (index: number) => list[index] ?? null }) as unknown as FileList;
}

let toastMark = 0;
function markToasts() { toastMark = toast.getHistory().length; }
function newToasts() { return toast.getHistory().slice(toastMark); }
function toastTitles(): string[] {
  return newToasts().map((item) => String("title" in item ? item.title : ""));
}

function installUploads(): string[] {
  const uploads: string[] = [];
  dom!.window.butlerApp = { uploadMessageFile: async ({ name, mimeType, bytes }: { name: string; mimeType: string; bytes: ArrayBuffer }) => {
    uploads.push(name);
    return { file: { file_id: name, safe_name: name, kind: mimeType.startsWith("image/") ? "image" : "generic",
      mime_type: mimeType, size_bytes: bytes.byteLength, url: `/message-files/${name}` } };
  } };
  return uploads;
}

test("picker accept excludes image types for a text-only model and keeps all-files otherwise", async () => {
  const container = mount();
  const inputRef = { current: null as HTMLInputElement | null };
  const input = () => container.querySelector("input[type='file']")!;
  await act(async () => {
    useComposerStore.setState({ activeModel: TEXT_ONLY });
    root!.render(<ComposerFileInput inputRef={inputRef} onFiles={() => undefined} />);
  });
  expect(input().getAttribute("data-picker-filter")).toBe("non-image");
  expect(input().getAttribute("accept")).not.toMatch(/image\/(\*|png|jpeg|webp|gif)|\.(png|jpe?g|webp|gif)\b/u);

  await act(async () => useComposerStore.setState({ activeModel: VISION }));
  expect(input().getAttribute("data-picker-filter")).toBe("all-files");
  expect(input().hasAttribute("accept")).toBe(false);

  const clicks: string[] = [];
  input().addEventListener("click", (event) => {
    event.preventDefault();
    clicks.push(`${input().getAttribute("data-picker-filter")}:${input().getAttribute("accept")}`);
  });
  await act(async () => useComposerStore.setState({ fileInputRef: inputRef }));
  await act(async () => useComposerStore.getState().openAttachmentPicker("images"));
  expect(clicks).toEqual(["images:image/png,image/jpeg,image/gif"]);
});

test("the image option in the + menu is disabled with a short tooltip for a text-only model", async () => {
  const container = mount();
  const openAttachmentPicker = mock((_kind?: "files" | "images") => undefined);
  useButlerStore.setState({ activeChatId: "draft:chat", navigation: EMPTY_NAVIGATION, settings: EMPTY_SETTINGS });
  useComposerStore.setState({ uploadingCount: 0, activeModel: TEXT_ONLY, openAttachmentPicker });
  await act(async () => root!.render(<ComposerAttachmentMenu />));
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-test-class="attachment-button"]')!
      .dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
  });
  const item = () => Array.from(dom!.window.document.querySelectorAll<HTMLButtonElement>('[data-slot="option-menu-item"]'))
    .find((node) => node.textContent?.includes(appCopy.composer.attachImage));
  expect(item()?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item()!.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true })));
  expect(openAttachmentPicker).not.toHaveBeenCalled();
  await act(async () => item()!.dispatchEvent(new dom!.window.MouseEvent("pointerover", { bubbles: true })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
  expect(dom!.window.document.querySelector('[role="tooltip"]')?.textContent).toBe("Model doesn't accept images");

  await act(async () => useComposerStore.setState({ activeModel: VISION }));
  expect(item()?.hasAttribute("aria-disabled")).toBe(false);
  await act(async () => item()!.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true })));
  expect(openAttachmentPicker).toHaveBeenCalledWith("images");
});

function AttachmentHarness({ chatId, policy, onState }: { chatId: string; policy: ComposerImagePolicy; onState: (state: ReturnType<typeof useFileAttachments>) => void }) {
  const state = useFileAttachments(chatId, policy);
  useComposerFileDrop((dropped) => void state.addFiles(dropped));
  onState(state);
  return null;
}

test("dropped and picked images are refused for a text-only model with a few-word toast; other files attach", async () => {
  mount();
  const uploads = installUploads();
  setAppCopyLanguage("ko-KR");
  markToasts();
  let state!: ReturnType<typeof useFileAttachments>;
  await act(async () => root!.render(<AttachmentHarness chatId="draft:drop" policy={composerImagePolicy(TEXT_ONLY)} onState={(next) => { state = next; }} />));
  const dropped = files(["photo.png", "image/png"], ["notes.pdf", "application/pdf"]);
  await act(async () => {
    const event = new dom!.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "none", files: dropped, types: ["Files"] } });
    dom!.window.document.body.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(uploads).toEqual(["notes.pdf"]);
  expect(state.attachments.map((item) => item.file.safe_name)).toEqual(["notes.pdf"]);
  expect(state.uploadingCount).toBe(0);
  expect(toastTitles()).toContain("이미지 미지원 모델");
  const refusal = newToasts().find((item) => "title" in item && item.title === "이미지 미지원 모델");
  expect(refusal && "description" in refusal ? refusal.description : undefined).toBeUndefined();
});

test("an image-capable model enforces the catalog MIME list and inline byte limit", async () => {
  mount();
  const uploads = installUploads();
  let state!: ReturnType<typeof useFileAttachments>;
  markToasts();
  await act(async () => root!.render(<AttachmentHarness chatId="draft:limits" policy={composerImagePolicy(VISION)} onState={(next) => { state = next; }} />));
  await act(async () => state.addFiles(files(["ok.png", "image/png"], ["a.webp", "image/webp"])));
  expect(uploads).toEqual(["ok.png"]);
  expect(toastTitles()).toEqual([appCopy.composer.imageTypeUnsupported]);
  markToasts();
  await act(async () => state.addFiles(files(["big.jpg", "image/jpeg", 101])));
  expect(uploads).toEqual(["ok.png"]);
  expect(toast.getHistory().map((item) => "title" in item ? item.title : "")).toContain(appCopy.composer.imageTooLarge);
});

test("pasted files go through the same gate instead of being dropped as text", () => {
  const handlers = new Map<unknown, (event: unknown) => boolean>();
  const editor = { registerCommand: (command: unknown, handler: (event: unknown) => boolean) => {
    handlers.set(command, handler); return () => undefined;
  } };
  const onFiles = mock((_files: FileList) => undefined);
  registerComposerClipboard(editor as never, () => true, onFiles);
  const pasted = [{ name: "shot.png", type: "image/png" }] as unknown as FileList;
  const preventDefault = mock(() => undefined);
  const handled = handlers.get(PASTE_COMMAND)?.({ clipboardData: { files: pasted, getData: () => "" }, preventDefault });
  expect(handled).toBe(true);
  expect(onFiles).toHaveBeenCalledWith(pasted);
  expect(preventDefault).toHaveBeenCalled();
});

function attachment(id: string, kind: ComposerAttachment["kind"], mime: string): ComposerAttachment {
  return { id, kind, file: { file_id: id, kind: kind === "image" ? "image" : "generic", mime_type: mime,
    safe_name: `${id}.${mime.split("/")[1]}`, size_bytes: 10, sha256: "", url: `/f/${id}`, created_at: "" } as MessageFileRef };
}

test("switching to a text-only model keeps attached images but blocks send with the short reason", async () => {
  const container = mount();
  const attachments = [attachment("shot", "image", "image/png"), attachment("doc", "generic", "application/pdf")];
  let state!: ReturnType<typeof useComposerState>;
  const catalog = { models: [TEXT_ONLY, VISION] } as never;
  function Harness({ modelRef }: { modelRef: string }) {
    state = useComposerState(null, {}, EMPTY_SETTINGS, catalog, modelRef, "ready", "hi", attachments, false, 0);
    return null;
  }
  await act(async () => root!.render(<Harness modelRef={VISION.model_ref} />));
  expect(state.canSend).toBe(true);
  expect(state.blockedAttachments.size).toBe(0);
  await act(async () => root!.render(<Harness modelRef={TEXT_ONLY.model_ref} />));
  expect(state.canSend).toBe(false);
  expect([...state.blockedAttachments.keys()]).toEqual(["shot"]);

  await act(async () => {
    useButlerStore.setState({ activeChatId: "draft:chat", navigation: EMPTY_NAVIGATION, settings: EMPTY_SETTINGS });
    useComposerStore.setState({ attachments, blockedAttachments: state.blockedAttachments, canSend: false, text: "hi" });
    root!.render(<><ComposerAttachments /><ComposerSendAction /></>);
  });
  const send = container.querySelector('[data-test-class="composer-send-button"]');
  expect(send?.getAttribute("aria-disabled")).toBe("true");
  expect(send?.getAttribute("type")).toBe("button");
  const chips = Array.from(container.querySelectorAll('[data-slot="attachment-item"]'));
  expect(chips.map((chip) => chip.getAttribute("data-blocked"))).toEqual(["true", null]);
  expect(chips[0]?.querySelector('[data-slot="attachment-name"]')?.getAttribute("aria-label"))
    .toBe(`shot.png, ${appCopy.composer.imagesUnsupported}`);
});

test("unknown image capability blocks images like text-only, with its own short reason", async () => {
  const container = mount();
  const openAttachmentPicker = mock((_kind?: "files" | "images") => undefined);
  useButlerStore.setState({ activeChatId: "draft:chat", navigation: EMPTY_NAVIGATION, settings: EMPTY_SETTINGS });
  useComposerStore.setState({ uploadingCount: 0, activeModel: UNKNOWN, openAttachmentPicker });
  await act(async () => root!.render(<ComposerAttachmentMenu />));
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-test-class="attachment-button"]')!
      .dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
  });
  const item = () => Array.from(dom!.window.document.querySelectorAll<HTMLButtonElement>('[data-slot="option-menu-item"]'))
    .find((node) => node.textContent?.includes(appCopy.composer.attachImage));
  expect(item()?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item()!.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true })));
  expect(openAttachmentPicker).not.toHaveBeenCalled();
  await act(async () => item()!.dispatchEvent(new dom!.window.MouseEvent("pointerover", { bubbles: true })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
  expect(dom!.window.document.querySelector('[role="tooltip"]')?.textContent).toBe("Image support unknown for this model");
  await act(async () => root!.render(null));

  const uploads = installUploads();
  setAppCopyLanguage("ko-KR");
  markToasts();
  let state!: ReturnType<typeof useFileAttachments>;
  await act(async () => root!.render(<AttachmentHarness chatId="draft:unknown" policy={composerImagePolicy(UNKNOWN)} onState={(next) => { state = next; }} />));
  await act(async () => state.addFiles(files(["photo.png", "image/png"], ["notes.pdf", "application/pdf"])));
  expect(uploads).toEqual(["notes.pdf"]);
  expect(toastTitles()).toContain("이미지 지원 여부를 확인할 수 없는 모델");
  const refusal = newToasts().find((item) => "title" in item && item.title === "이미지 지원 여부를 확인할 수 없는 모델");
  expect(refusal && "description" in refusal ? refusal.description : undefined).toBeUndefined();
  setAppCopyLanguage("en-US");

  const attachments = [attachment("shot", "image", "image/png")];
  let composer!: ReturnType<typeof useComposerState>;
  const catalog = { models: [UNKNOWN, VISION] } as never;
  function Harness({ modelRef }: { modelRef: string }) {
    composer = useComposerState(null, {}, EMPTY_SETTINGS, catalog, modelRef, "ready", "hi", attachments, false, 0);
    return null;
  }
  await act(async () => root!.render(<Harness modelRef={UNKNOWN.model_ref} />));
  expect(composer.canSend).toBe(false);
  expect([...composer.blockedAttachments.entries()]).toEqual([["shot", "unknown"]]);
  await act(async () => {
    useComposerStore.setState({ attachments, blockedAttachments: composer.blockedAttachments, canSend: false, text: "hi" });
    root!.render(<><ComposerAttachments /><ComposerSendAction /></>);
  });
  expect(container.querySelector('[data-slot="attachment-name"]')?.getAttribute("aria-label"))
    .toBe("shot.png, Image support unknown for this model");
  expect(container.querySelector('[data-test-class="composer-send-button"]')?.getAttribute("aria-disabled")).toBe("true");
});
