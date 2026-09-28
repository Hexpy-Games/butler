/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { WallpaperImageLoaderProvider, useWallpaperImageLoader } from "./imageLoaderContext";
import { defineWallpaperModule } from "./manifest";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry, type WallpaperRegistry } from "./registry";
import { WallpaperRegistryProvider, useWallpaperRegistry, useWallpaperUserModules } from "./registryContext";
import type { WallpaperError, WallpaperImageLoader } from "./types";
import { Wallpaper } from "./Wallpaper";

function canvasOf(markup: string) {
  return new JSDOM(markup).window.document.querySelector("canvas");
}

test("a live source renders a decorative canvas that names its module, scope and tone", () => {
  const canvas = canvasOf(renderToStaticMarkup(
    <Wallpaper source={{ kind: "live", module: "butler.silk" }} tone="dark" dataTestClass="new-chat-fluid-gradient" />,
  ));
  expect(canvas?.getAttribute("aria-hidden")).toBe("true");
  expect(canvas?.getAttribute("data-test-class")).toBe("wallpaper new-chat-fluid-gradient");
  expect(canvas?.getAttribute("data-module")).toBe("butler.silk");
  expect(canvas?.getAttribute("data-scope")).toBe("viewport");
  expect(canvas?.getAttribute("data-tone")).toBe("dark");
});

test("container scope fills the parent instead of the viewport", () => {
  const canvas = canvasOf(renderToStaticMarkup(<Wallpaper source={{ kind: "live", module: "butler.bloom" }} scope="container" />));
  expect(canvas?.getAttribute("data-scope")).toBe("container");
  expect(canvas?.getAttribute("data-test-class")).toBe("wallpaper");
});

test("image sources name the image module, or the filter that draws them", () => {
  const image = canvasOf(renderToStaticMarkup(<Wallpaper source={{ kind: "image", asset: "a1", fit: "cover", dim: 0, blur: 0 }} />));
  expect(image?.getAttribute("data-module")).toBe("butler.image");
  const filtered = canvasOf(renderToStaticMarkup(
    <Wallpaper source={{ kind: "image", asset: "a1", fit: "cover", dim: 0, blur: 0, filter: { module: "me.grain" } }} />,
  ));
  expect(filtered?.getAttribute("data-module")).toBe("me.grain");
});

test("a hidden, decorative crossfade layer follows the wallpaper canvas", () => {
  const document = new JSDOM(renderToStaticMarkup(<Wallpaper source={{ kind: "live", module: "butler.bloom" }} scope="container" />)).window.document;
  const [canvas, crossfade] = [...document.querySelectorAll("canvas")];
  expect(canvas?.hasAttribute("hidden")).toBe(false);
  expect(crossfade?.hasAttribute("hidden")).toBe(true);
  expect(crossfade?.getAttribute("aria-hidden")).toBe("true");
  expect(crossfade?.getAttribute("class")).toBe(canvas?.getAttribute("class"));
});

test("the imageLoader prop wins over the nearest provider", () => {
  const fromProvider: WallpaperImageLoader = () => Promise.resolve(new Blob());
  const fromProp: WallpaperImageLoader = () => Promise.resolve(new Blob());
  const seen: Array<WallpaperImageLoader | undefined> = [];
  function Probe({ loader }: { loader?: WallpaperImageLoader }) {
    seen.push(useWallpaperImageLoader(loader));
    return null;
  }
  renderToStaticMarkup(
    <WallpaperImageLoaderProvider loader={fromProvider}>
      <Probe />
      <Probe loader={fromProp} />
    </WallpaperImageLoaderProvider>,
  );
  renderToStaticMarkup(<Probe />);
  expect(seen).toEqual([fromProvider, fromProp, undefined]);
});

test("none renders nothing", () => {
  expect(renderToStaticMarkup(<Wallpaper source={{ kind: "none" }} />)).toBe("");
});

/** Mounts in a jsdom window whose canvases have no WebGL (the engine reports `unsupported`). */
async function mount(node: ReactNode) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(node));
  return {
    document: dom.window.document,
    render: (next: ReactNode) => act(async () => root.render(next)),
    async cleanup() {
      await act(async () => root.unmount());
      saved.forEach(([key, descriptor]) => {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      });
    },
  };
}

test("switching to none keeps the canvas mounted so the last frame can fade out", async () => {
  const view = await mount(<Wallpaper source={{ kind: "live", module: "butler.bloom" }} tone="light" />);
  try {
    await view.render(<Wallpaper source={{ kind: "none" }} tone="light" />);
    const canvases = view.document.querySelectorAll("canvas");
    expect(canvases).toHaveLength(2);
    expect(canvases[0]?.getAttribute("data-module")).toBe("none");
    await view.render(<Wallpaper source={{ kind: "live", module: "butler.silk" }} tone="light" />);
    expect(view.document.querySelector("canvas")?.getAttribute("data-module")).toBe("butler.silk");
  } finally {
    await view.cleanup();
  }
});

const FLOW = defineWallpaperModule({
  manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
  fragment: "void main(){fragColor=vec4(1.);}",
});

test("the registry and user modules come from the nearest WallpaperRegistryProvider; a registry prop wins", () => {
  const registry = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), FLOW]);
  const userModules = [{ id: "me.flow", name: FLOW.manifest.name }, { id: "me.broken", name: { en: "Broken", ko: "깨짐" }, error: "ERROR: 0:1: x" }];
  const seen: Array<[WallpaperRegistry, readonly unknown[]]> = [];
  function Probe({ registry: explicit }: { registry?: WallpaperRegistry }) {
    seen.push([useWallpaperRegistry(explicit), useWallpaperUserModules()]);
    return null;
  }
  renderToStaticMarkup(
    <WallpaperRegistryProvider registry={registry} userModules={userModules}>
      <Probe />
      <Probe registry={BUILTIN_WALLPAPERS} />
    </WallpaperRegistryProvider>,
  );
  renderToStaticMarkup(<Probe />);
  expect(seen).toEqual([[registry, userModules], [BUILTIN_WALLPAPERS, userModules], [BUILTIN_WALLPAPERS, []]]);
});

test("errors reach both the onError prop and the provider's reporter", async () => {
  const fromProp: WallpaperError[] = [];
  const fromProvider: WallpaperError[] = [];
  const view = await mount(
    <WallpaperRegistryProvider registry={BUILTIN_WALLPAPERS} onError={(error) => fromProvider.push(error)}>
      <Wallpaper source={{ kind: "live", module: "butler.bloom" }} tone="light" onError={(error) => fromProp.push(error)} />
    </WallpaperRegistryProvider>,
  );
  try {
    expect(fromProp.map((error) => error.reason)).toEqual(["unsupported"]);
    expect(fromProvider).toEqual(fromProp);
  } finally {
    await view.cleanup();
  }
});
