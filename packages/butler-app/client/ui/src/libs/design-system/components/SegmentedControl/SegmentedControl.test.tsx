/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { SegmentedControl } from "./SegmentedControl";

const KEYS = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const options = [{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }];

test("SegmentedControl is a radiogroup with roving focus, arrow keys and click selection", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const changes: string[] = [];
  function Harness() {
    const [value, setValue] = useState("30");
    return <SegmentedControl ariaLabel="Period" options={options} value={value}
      onValueChange={(next) => { changes.push(next); setValue(next); }} />;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<Harness />));
    const group = dom.window.document.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Period");
    const radios = () => [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    await act(async () => radios()[1]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(changes).toEqual(["90"]);
    expect(dom.window.document.activeElement).toBe(radios()[2]);
    await act(async () => radios()[2]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(changes.at(-1)).toBe("7");
    await act(async () => radios()[1]!.click());
    expect(changes.at(-1)).toBe("30");
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    expect(radios()[1]!.type).toBe("button");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
