import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appCopy } from "@/app/copy.ts";
import { MessageMarkdown } from "./MessageMarkdown";
import { UserMessageFooter } from "./UserMessageFooter";
import { UserMessageText } from "./UserMessageText";

let dom: JSDOM;
let container: HTMLElement;
let root: Root;
let copied: string[];
let measure: () => void;
let contentHeight: number;

beforeEach(() => {
  dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  copied = [];
  contentHeight = 120;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(callback: () => void) { measure = callback; }
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    get: () => contentHeight,
  });
  dom.window.getComputedStyle = () => ({ lineHeight: "20px" }) as CSSStyleDeclaration;
  container = dom.window.document.getElementById("root")!;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  setSystemTime();
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

test("user message folding follows rendered height and keeps More/Less while expanded", async () => {
  const text = "A single source line that wraps across six visual lines.";
  await act(async () => root.render(<UserMessageText text={text} />));
  const button = container.querySelector("button")!;
  const content = container.querySelector('[data-test-class="user-message-text"]')!;
  expect(button.textContent).toBe(appCopy.conversation.messageActions.showMore);
  expect(button.getAttribute("aria-controls")).toBe(content.id);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await act(async () => button.click());
  await act(async () => measure());
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.textContent).toBe(appCopy.conversation.messageActions.showLess);
  expect(content.textContent).toBe(text);
  await act(async () => button.click());
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { contentHeight = 100; measure(); });
  expect(container.querySelector("button")).toBeNull();
  await act(async () => { contentHeight = 140; measure(); });
  expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});

test("user footer displays original sent date and copies the complete text", async () => {
  const text = "first\nsecond\nthird\nfourth\nfifth\nsixth — still copied";
  await act(async () => root.render(
    <UserMessageFooter message={{
      id: "user", role: "user", text,
      created_at: "2026-09-03T10:00:00Z",
      updated_at: "2026-09-04T11:00:00Z",
    }} />,
  ));
  expect(container.querySelector("time")?.dateTime).toBe("2026-09-03T10:00:00.000Z");
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe(appCopy.conversation.messageActions.copyMessage);
  expect(button.textContent).toBe("");
  await act(async () => button.focus());
  expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent)
    .toBe(appCopy.conversation.messageActions.copyMessage);
  await act(async () => button.click());
  expect(copied).toEqual([text]);
  expect(button.textContent).toBe("");
  expect(button.getAttribute("aria-label")).toBe(appCopy.conversation.messageActions.copied);
  expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent)
    .toBe(appCopy.conversation.messageActions.copied);
  await act(async () => root.render(
    <UserMessageFooter message={{ id: "missing-date", role: "user", text }} />,
  ));
  expect(container.querySelector("time")).toBeNull();
});

test("sent time includes only the date parts needed for the local calendar day", async () => {
  setSystemTime(new Date(2026, 8, 3, 12, 0));
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const cases: Array<[Date, Intl.DateTimeFormatOptions]> = [
    [new Date(2026, 8, 3, 9, 15), time],
    [new Date(2026, 7, 3, 9, 15), { ...time, month: "short", day: "numeric" }],
    [new Date(2025, 8, 3, 9, 15), { ...time, year: "numeric", month: "short", day: "numeric" }],
  ];
  for (const [date, options] of cases) {
    await act(async () => root.render(
      <UserMessageFooter message={{ id: "dated", role: "user", text: "hello", created_at: date.toISOString() }} />,
    ));
    expect(container.querySelector("time")?.textContent)
      .toBe(new Intl.DateTimeFormat(undefined, options).format(date));
  }
});

test("Markdown code copy copies only the selected full block and preserves inline code", async () => {
  const code = "function test() {\n  return 42;\n}\n";
  const markdown = "Before with `inline`.\n\n```ts\n" + code + "```\n\n```sh\necho done\n```";
  await act(async () => root.render(<MessageMarkdown text={markdown} />));
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  expect(buttons.length).toBe(2);
  expect(container.querySelector("p code")?.textContent).toBe("inline");
  await act(async () => buttons[0]!.click());
  await act(async () => buttons[1]!.click());
  expect(copied).toEqual([code, "echo done\n"]);
  expect(container.querySelectorAll("pre").length).toBe(2);
});
