import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

test("Recent and Running keep location left and their secondary fact right", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, globals);
  const { useMock } = await import("@/app/prototypes/sidebar-space/mock-store");
  const { SpaceRowLabel } = await import("./SpaceRowLabel");
  const previousState = useMock.getState();
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    const item = previousState.items.find((row) => row.activity === "working")!;
    const metadata = async (view: "recent" | "running") => {
      await act(async () => {
        useMock.setState({ view });
        root.render(<SpaceRowLabel id={item.id} flat />);
      });
      expect(container.querySelector("[role=status]")).toBeNull();
      return container.firstElementChild!.lastElementChild!.cloneNode(
        true,
      ) as Element;
    };
    const recent = await metadata("recent");
    const running = await metadata("running");
    expect(recent.children.length).toBe(2);
    expect(running.children.length).toBe(2);
    expect(running.children[0].textContent).toBe(
      recent.children[0].textContent,
    );
    expect(recent.children[0].textContent).toBe("Sandy");
    expect(recent.children[1].tagName).toBe("TIME");
    expect(running.children[1].textContent).toBe("작업 중 · 2/3");
  } finally {
    await act(async () => root.unmount());
    useMock.setState(previousState, true);
    dom.window.close();
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
