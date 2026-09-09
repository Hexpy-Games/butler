import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

test("drag indicators belong to one instance and follow group header geometry", async () => {
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
  const { TreeDragItem } = await import("./TreeDragItem");
  const { useTreeDrag } = await import("./hooks/useTreeDrag");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <TreeDragItem id="insurance" enabled={false}>
            Favorite
          </TreeDragItem>
          <TreeDragItem id="insurance">Tree</TreeDragItem>
          <TreeDragItem id="health">
            <div data-test-class="tree-row">Group header</div>
            <div>Expanded children</div>
          </TreeDragItem>
        </>,
      ),
    );
    const [favorite, tree] = Array.from(container.children) as HTMLElement[];
    expect(favorite.dataset.dragInstance).not.toBe(tree.dataset.dragInstance);
    await act(async () =>
      useTreeDrag.getState().start("insurance", favorite.dataset.dragInstance!),
    );
    expect(favorite.dataset.dragging).toBe("true");
    expect(tree.dataset.dragging).toBeUndefined();
    await act(async () =>
      useTreeDrag.getState().over({
        id: "insurance",
        instance: tree.dataset.dragInstance!,
        position: "before",
      }),
    );
    expect(tree.dataset.drop).toBe("before");
    expect(favorite.dataset.drop).toBeUndefined();

    const over = new dom.window.Event("dragover", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(over, "dataTransfer", {
      value: { dropEffect: "move" },
    });
    await act(async () => {
      favorite.dispatchEvent(over);
    });
    expect(container.querySelectorAll("[data-drop]").length).toBe(0);
    await act(async () => useTreeDrag.getState().end());
    expect(container.querySelectorAll("[data-dragging]").length).toBe(0);
    const group = container.children[2] as HTMLElement;
    const header = group.firstElementChild as HTMLElement;
    group.getBoundingClientRect = () => ({ top: 40, height: 200 }) as DOMRect;
    header.getBoundingClientRect = () => ({ top: 64, height: 32 }) as DOMRect;
    await act(async () => useTreeDrag.getState().start("kyoto", "source"));
    const groupOver = new dom.window.Event("dragover", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(groupOver, {
      dataTransfer: { value: { dropEffect: "move" } },
      clientY: { value: 95 },
    });
    await act(async () => group.dispatchEvent(groupOver));
    expect(group.dataset.drop).toBe("after");
    expect(group.style.getPropertyValue("--drop-row-top")).toBe("24px");
    expect(group.style.getPropertyValue("--drop-row-height")).toBe("32px");
  } finally {
    await act(async () => root.unmount());
    useTreeDrag.getState().end();
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
