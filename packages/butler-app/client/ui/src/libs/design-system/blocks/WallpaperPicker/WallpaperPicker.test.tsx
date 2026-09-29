/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  BLOOM_WALLPAPER,
  GRAIN_WALLPAPER,
  SILK_WALLPAPER,
  WallpaperRegistryProvider,
  createWallpaperRegistry,
  defineWallpaperModule,
  type WallpaperImageLoader,
  type WallpaperUserModule,
} from "../Wallpaper";
import type { WallpaperPickerLabels, WallpaperPickerValue } from "./types";
import { WallpaperPicker, type WallpaperPickerProps } from "./WallpaperPicker";

const LABELS: WallpaperPickerLabels = {
  options: "Wallpaper", none: "None", image: (index) => `Image ${index}`, addImage: "Add image", deleteImage: "Delete image",
  fit: "Fit", fill: "Fill", fitWhole: "Whole", dim: "Dim", blur: "Blur", filter: "Filter", noFilter: "No filter", mine: "Mine",
  importModule: "Import module", deleteModule: "Delete module",
};
const IMAGES = [{ id: "wp_dark", luminance: 0.1 }, { id: "wp_bright", luminance: 0.9 }];
/** A short registry (two live modules, one filter) keeps tile lists readable; the built-ins are covered in pickerModel.test.ts. */
const CORE_REGISTRY = createWallpaperRegistry([BLOOM_WALLPAPER, SILK_WALLPAPER, GRAIN_WALLPAPER]);
const withCore = (node: ReactNode) => <WallpaperRegistryProvider registry={CORE_REGISTRY}>{node}</WallpaperRegistryProvider>;

type Props = Omit<WallpaperPickerProps, "value" | "onChange" | "labels" | "locale">;

/** A controlled picker in a jsdom window (no WebGL: module stills stay empty); returns every onChange value. */
async function mount(initial: WallpaperPickerValue, props: Props = {}, locale: "en-US" | "ko-KR" = "en-US", wrap = withCore) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "FileReader", "Blob", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, FileReader: dom.window.FileReader, Blob: dom.window.Blob, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const changes: WallpaperPickerValue[] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return <WallpaperPicker {...props} labels={LABELS} locale={locale} tone="light" value={value}
      onChange={(next) => { changes.push(next); setValue(next); }} />;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(wrap(<Harness />)));
  const document = dom.window.document;
  const tile = (key: string) => document.querySelector<HTMLElement>(`[data-option="${key}"]`);
  const radio = (key: string) => tile(key)?.querySelector<HTMLButtonElement>('[role="radio"]') ?? null;
  const group = (label: string) => document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
  return {
    dom, document, changes, tile, radio, group,
    act: (run: () => void) => act(async () => run()),
    choose: (label: string, option: string) => act(async () => {
      [...(group(label)?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find((item) => item.textContent === option)?.click();
    }),
    slide: (label: string, value: number) => act(async () => {
      const input = document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    }),
    async cleanup() {
      // Let queued jsdom events (selectionchange after focus) and thumbnail loads settle inside act.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      await act(async () => root.unmount());
      saved.forEach(([key, descriptor]) => {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      });
    },
  };
}

test("tiles: none, live modules (names from the manifest), images and the upload tile; the value's tile is checked", async () => {
  const view = await mount({ kind: "live", module: "butler.silk" }, { images: IMAGES, onUpload: () => undefined });
  try {
    const options = [...view.document.querySelectorAll("[data-option]")].map((tile) => [tile.getAttribute("data-option"), tile.textContent]);
    expect(options).toEqual([
      ["none", "None"], ["live:butler.bloom", "Bloom"], ["live:butler.silk", "Silk"], ["image:wp_dark", "Image 1"], ["image:wp_bright", "Image 2"],
      ["upload", "Add image"],
    ]);
    expect(view.radio("live:butler.silk")?.getAttribute("aria-checked")).toBe("true");
    expect(view.radio("live:butler.silk")?.tabIndex).toBe(0);
    expect(view.radio("none")?.tabIndex).toBe(-1);
    // Silk's manifest param: a color swatch labelled in the locale.
    expect(view.document.querySelector('input[type="color"]')?.getAttribute("aria-label")).toBe("Base color");
  } finally {
    await view.cleanup();
  }
});

test("an inherit tile comes first when offered", async () => {
  const view = await mount("inherit", { inherit: { label: "Same as Home", source: { kind: "none" } } }, "ko-KR");
  try {
    expect(view.document.querySelector("[data-option]")?.getAttribute("data-option")).toBe("inherit");
    expect(view.radio("inherit")?.getAttribute("aria-checked")).toBe("true");
    expect(view.tile("live:butler.bloom")?.textContent).toBe("Bloom");
    await view.act(() => view.radio("none")?.click());
    await view.act(() => view.radio("inherit")?.click());
    expect(view.changes).toEqual([{ kind: "none" }, "inherit"]);
  } finally {
    await view.cleanup();
  }
});

test("picking an image fills the screen with a dim from its luminance; its controls edit fit, dim, blur and filter", async () => {
  const view = await mount({ kind: "live", module: "butler.bloom" }, { images: IMAGES });
  try {
    await view.act(() => view.radio("image:wp_bright")?.click());
    expect(view.changes.at(-1)).toEqual({ kind: "image", asset: "wp_bright", fit: "cover", dim: 0.4, blur: 0 });
    await view.choose("Fit", "Whole");
    await view.slide("Blur", 0.25);
    await view.choose("Filter", "Grain");
    expect(view.changes.at(-1)).toEqual({ kind: "image", asset: "wp_bright", fit: "contain", dim: 0.4, blur: 0.25, filter: { module: "butler.grain" } });
    // The filter's own params follow (grain: amount, black and white).
    await view.slide("Amount", 0.8);
    expect(view.changes.at(-1)).toMatchObject({ filter: { module: "butler.grain", params: { amount: 0.8 } } });
    await view.choose("Filter", "No filter");
    expect(view.changes.at(-1)).toEqual({ kind: "image", asset: "wp_bright", fit: "contain", dim: 0.4, blur: 0.25 });
  } finally {
    await view.cleanup();
  }
});

test("re-picking a tile restores what it had; params edit the selected module", async () => {
  const view = await mount({ kind: "image", asset: "wp_dark", fit: "cover", dim: 0, blur: 0 }, { images: IMAGES });
  try {
    await view.slide("Dim", 0.3);
    await view.act(() => view.radio("live:butler.bloom")?.click());
    await view.choose("Colors", "Aurora");
    expect(view.changes.at(-1)).toEqual({ kind: "live", module: "butler.bloom", params: { colors: "aurora" }, paramsDark: { colors: "aurora" } });
    await view.act(() => view.radio("image:wp_dark")?.click());
    expect(view.changes.at(-1)).toEqual({ kind: "image", asset: "wp_dark", fit: "cover", dim: 0.3, blur: 0 });
    await view.act(() => view.radio("live:butler.bloom")?.click());
    expect(view.changes.at(-1)).toMatchObject({ params: { colors: "aurora" } });
  } finally {
    await view.cleanup();
  }
});

test("arrow keys move the selection; Home and End jump", async () => {
  const view = await mount({ kind: "none" });
  try {
    const key = (target: Element | null, name: string) => view.act(() => {
      target?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: name, bubbles: true }));
    });
    await key(view.radio("none"), "ArrowRight");
    await key(view.radio("live:butler.bloom"), "End");
    await key(view.radio("live:butler.silk"), "ArrowRight");
    expect(view.changes).toEqual([{ kind: "live", module: "butler.bloom" }, { kind: "live", module: "butler.silk" }, { kind: "none" }]);
  } finally {
    await view.cleanup();
  }
});

test("images other than the selected one can be deleted", async () => {
  const deleted: string[] = [];
  const view = await mount({ kind: "image", asset: "wp_dark", fit: "cover", dim: 0, blur: 0 }, { images: IMAGES, onDeleteImage: (id) => deleted.push(id) });
  try {
    expect(view.tile("image:wp_dark")?.querySelector('[aria-label="Delete image"]')).toBeNull();
    await view.act(() => view.tile("image:wp_bright")?.querySelector<HTMLButtonElement>('[aria-label="Delete image"]')?.click());
    expect(deleted).toEqual(["wp_bright"]);
    expect(view.changes).toEqual([]);
  } finally {
    await view.cleanup();
  }
});

test("the upload tile takes a chosen or dropped file; it holds still while uploading", async () => {
  const uploads: string[] = [];
  const view = await mount({ kind: "none" }, { onUpload: (file) => uploads.push(file.name) });
  try {
    const { window } = view.dom;
    const input = view.document.querySelector<HTMLInputElement>('[data-option="upload"] input[type="file"]')!;
    expect(input.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp");
    const chosen = new window.File(["x"], "chosen.png", { type: "image/png" });
    await view.act(() => {
      Object.defineProperty(input, "files", { configurable: true, value: [chosen] });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const dropped = new window.File(["y"], "dropped.jpg", { type: "image/jpeg" });
    const drag = (type: string) => Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), {
      dataTransfer: { types: ["Files"], files: [dropped], dropEffect: "none" },
    });
    await view.act(() => view.radio("none")?.dispatchEvent(drag("dragover")));
    expect(view.tile("upload")?.querySelector("button")?.getAttribute("data-drop-active")).toBe("true");
    await view.act(() => view.radio("none")?.dispatchEvent(drag("drop")));
    expect(uploads).toEqual(["chosen.png", "dropped.jpg"]);
    expect(view.tile("upload")?.querySelector("button")?.hasAttribute("data-drop-active")).toBe(false);
  } finally {
    await view.cleanup();
  }
  const busy = await mount({ kind: "none" }, { onUpload: () => uploads.push("late"), uploading: true });
  try {
    expect(busy.tile("upload")?.querySelector("button")?.disabled).toBe(true);
  } finally {
    await busy.cleanup();
  }
});

test("the import-module tile takes a chosen zip; it holds still while importing", async () => {
  const imports: string[] = [];
  const view = await mount({ kind: "none" }, { onImportModule: (file) => imports.push(file.name) });
  try {
    const input = view.document.querySelector<HTMLInputElement>('[data-option="import-module"] input[type="file"]')!;
    expect(input.getAttribute("accept")).toBe(".zip,application/zip");
    const chosen = new view.dom.window.File(["z"], "module.zip", { type: "application/zip" });
    await view.act(() => {
      Object.defineProperty(input, "files", { configurable: true, value: [chosen] });
      input.dispatchEvent(new view.dom.window.Event("change", { bubbles: true }));
    });
    expect(imports).toEqual(["module.zip"]);
    expect(view.tile("import-module")?.textContent).toBe("Import module");
  } finally {
    await view.cleanup();
  }
  const busy = await mount({ kind: "none" }, { onImportModule: () => imports.push("late"), importingModule: true });
  try {
    expect(busy.tile("import-module")?.querySelector("button")?.disabled).toBe(true);
  } finally {
    await busy.cleanup();
  }
});

test("image tiles show the loader's thumbnail", async () => {
  const requests: string[][] = [];
  const loader: WallpaperImageLoader = (asset, variant) => {
    requests.push([asset, variant]);
    return Promise.resolve(new Blob(["png"], { type: "image/png" }));
  };
  const view = await mount({ kind: "none" }, { images: [{ id: "wp_dark" }], imageLoader: loader });
  try {
    await view.act(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await view.act(() => undefined);
    expect(requests).toEqual([["wp_dark", "thumbnail"]]);
    expect(view.tile("image:wp_dark")?.querySelector("img")?.getAttribute("src")).toStartWith("data:image/png;base64,");
  } finally {
    await view.cleanup();
  }
});

const FLOW = defineWallpaperModule({
  manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
  fragment: "void main(){fragColor=vec4(1.);}",
});
const USER_REGISTRY = createWallpaperRegistry([...CORE_REGISTRY.list(), FLOW]);
const USER_MODULES: WallpaperUserModule[] = [
  { id: "me.flow", name: FLOW.manifest.name },
  { id: "me.broken", name: { en: "Broken", ko: "깨짐" }, error: "\nERROR: 0:3: 'x' : undeclared identifier\nERROR: 1 compilation errors" },
  { id: "me.nameless", error: "name: needs non-empty en and ko" },
];

test("user modules follow the built-ins, marked as the user's; a failing one is disabled with its first error line as tooltip", async () => {
  const view = await mount({ kind: "none" }, { registry: USER_REGISTRY, userModules: USER_MODULES });
  try {
    const options = [...view.document.querySelectorAll("[data-option]")].map((tile) => tile.getAttribute("data-option"));
    expect(options).toEqual(["none", "live:butler.bloom", "live:butler.silk", "live:me.flow", "live:me.broken", "live:me.nameless"]);
    const mine = (key: string) => view.tile(key)?.querySelector('[data-slot="wallpaper-picker-mine"]')?.textContent ?? null;
    expect([mine("live:butler.bloom"), mine("live:me.flow"), mine("live:me.broken")]).toEqual([null, "Mine", "Mine"]);
    // Without a valid name the id shows.
    expect(view.tile("live:me.nameless")?.textContent).toContain("me.nameless");
    const broken = view.radio("live:me.broken");
    expect(broken?.getAttribute("aria-disabled")).toBe("true");
    expect(view.radio("live:me.flow")?.hasAttribute("aria-disabled")).toBe(false);
    await view.act(() => broken?.click());
    expect(view.changes).toEqual([]);
    await view.act(() => broken?.dispatchEvent(new view.dom.window.MouseEvent("pointerover", { bubbles: true })));
    await view.act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(view.document.querySelector('[role="tooltip"]')?.textContent).toBe("ERROR: 0:3: 'x' : undeclared identifier");
    await view.act(() => view.radio("live:me.flow")?.click());
    expect(view.changes).toEqual([{ kind: "live", module: "me.flow" }]);
  } finally {
    await view.cleanup();
  }
});

test("the user's own module tiles get a delete button except the selected one; built-ins never do", async () => {
  const deleted: string[] = [];
  const view = await mount(
    { kind: "live", module: "me.flow" },
    { registry: USER_REGISTRY, userModules: USER_MODULES, onDeleteModule: (id) => deleted.push(id) },
  );
  try {
    expect(view.tile("live:butler.bloom")?.querySelector('[aria-label="Delete module"]')).toBeNull();
    // The selected module is in use: no delete button.
    expect(view.tile("live:me.flow")?.querySelector('[aria-label="Delete module"]')).toBeNull();
    // A broken module (aria-disabled) still gets one: it can be removed even while it cannot be used.
    await view.act(() => view.tile("live:me.broken")?.querySelector<HTMLButtonElement>('[aria-label="Delete module"]')?.click());
    await view.act(() => view.tile("live:me.nameless")?.querySelector<HTMLButtonElement>('[aria-label="Delete module"]')?.click());
    expect(deleted).toEqual(["me.broken", "me.nameless"]);
    expect(view.changes).toEqual([]);
  } finally {
    await view.cleanup();
  }
});

test("arrow keys skip modules that cannot be used", async () => {
  const view = await mount({ kind: "live", module: "me.flow" }, { registry: USER_REGISTRY, userModules: USER_MODULES });
  try {
    await view.act(() => {
      view.radio("live:me.flow")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(view.changes).toEqual([{ kind: "none" }]);
  } finally {
    await view.cleanup();
  }
});

test("the registry and user modules come from the nearest WallpaperRegistryProvider", async () => {
  const view = await mount({ kind: "none" }, {}, "ko-KR", (node) => (
    <WallpaperRegistryProvider registry={USER_REGISTRY} userModules={USER_MODULES.slice(0, 1)}>{node}</WallpaperRegistryProvider>
  ));
  try {
    expect(view.tile("live:me.flow")?.textContent).toBe("흐름Mine");
  } finally {
    await view.cleanup();
  }
});
