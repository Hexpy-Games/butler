import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { MessageChangedFiles } from "./MessageChangedFiles.tsx";

const files = Array.from({ length: 7 }, (_, index) => ({
  path: `src/file-${index + 1}.ts`, additions: 2, deletions: 1, lines: [],
}));

afterEach(() => {
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

test("shows five files, expands all on More, and keeps full totals when collapsed", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MessageChangedFiles files={files} />));
    expect(container.textContent).toContain(appCopy.conversation.fileChanges.titleSummary(7, 14, 7));
    expect(container.textContent).toContain("src/file-5.ts");
    expect(container.textContent).not.toContain("src/file-6.ts");
    const toggle = container.querySelector<HTMLButtonElement>('[data-test-class="toggle-changed-files"]')!;
    expect(toggle.textContent).toBe(appCopy.conversation.fileChanges.showMore(2));
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("src/file-7.ts");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("src/file-6.ts");
    expect(container.textContent).toContain(appCopy.conversation.fileChanges.titleSummary(7, 14, 7));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("five or fewer files need no More button and an empty list stays hidden", () => {
  const html = renderToStaticMarkup(<MessageChangedFiles files={files.slice(0, 5)} />);
  expect(html).toContain("src/file-5.ts");
  expect(html).not.toContain("toggle-changed-files");
  expect(renderToStaticMarkup(<MessageChangedFiles files={[]} />)).toBe("");
});
