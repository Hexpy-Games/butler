// test-category: race
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createSidebarPeekController, PEEK_DISMISS_MS, type SidebarPeekCloseReason } from "./sidebarPeek";

/** A controller over a 304×800 sidebar at the window's left, with manual timers. */
function peek() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const changes: Array<[boolean, SidebarPeekCloseReason | undefined]> = [];
  const sidebar = { getBoundingClientRect: () => ({ left: 8, top: 8, right: 312, bottom: 792 }) } as unknown as Element;
  const controller = createSidebarPeekController({
    sidebar: () => sidebar,
    onChange: (open, reason) => changes.push([open, reason]),
    setTimer: (run) => { const id = next++; timers.set(id, run); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const fire = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((run) => run()); };
  return { controller, changes, timers, fire };
}

test("leaving the sidebar dismisses after a short delay that coming back cancels", () => {
  const { controller, changes, timers, fire } = peek();
  expect(PEEK_DISMISS_MS).toBe(240);
  controller.show();
  controller.pointerLeave();
  expect(timers.size).toBe(1);
  controller.pointerEnter();
  expect(timers.size).toBe(0);
  controller.pointerLeave();
  fire();
  expect(changes).toEqual([[true, undefined], [false, "pointer-left"]]);
});

test("a native view's host signal closes the peek the DOM cannot", () => {
  const { controller, changes, fire } = peek();
  controller.show();
  controller.pointerOutside();
  fire();
  expect(changes.at(-1)).toEqual([false, "pointer-outside"]);
});

test("host pointer positions arm inside-out and cancel outside-in", () => {
  const { controller, changes, timers, fire } = peek();
  controller.show();
  controller.pointerAt({ x: 700, y: 300 });
  expect(timers.size).toBe(1);
  controller.pointerAt({ x: 120, y: 300 });
  expect(timers.size).toBe(0);
  controller.pointerAt({ x: 700, y: 300 });
  fire();
  expect(changes.at(-1)).toEqual([false, "pointer-outside"]);
});

test("blur, Escape and a press outside close at once; a closed peek ignores signals", () => {
  for (const reason of ["window-blur", "escape", "press-outside"] as const) {
    const { controller, changes, timers } = peek();
    controller.show();
    controller.pointerLeave();
    controller.close(reason);
    expect({ reason, changes, pending: timers.size }).toEqual({ reason, changes: [[true, undefined], [false, reason]], pending: 0 });
    controller.pointerOutside();
    expect(timers.size).toBe(0);
  }
});

test("a controlled owner's state is followed without reporting back", () => {
  const { controller, changes, timers } = peek();
  controller.sync(true);
  expect(controller.isOpen()).toBe(true);
  controller.pointerLeave();
  expect(timers.size).toBe(1);
  controller.sync(false);
  expect(timers.size).toBe(0);
  expect(changes).toEqual([]);
});
