import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import s from "./LayoutHero.module.css";

const DOC = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";

/** Style sheets of the page (the DS and its tokens), for a frame's own document. */
function isSheet(node: Node): node is HTMLStyleElement | HTMLLinkElement {
  return node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === "stylesheet");
}

function copySheet(node: HTMLStyleElement | HTMLLinkElement): Node {
  const copy = node.cloneNode(true) as HTMLStyleElement | HTMLLinkElement;
  if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
  return copy;
}

/**
 * A device viewport: its children render into the frame's own document, so
 * the app's media queries, `vw` and `vh`, and fixed drawers resolve against
 * the frame's width and height exactly as in a window that size. The page's
 * style sheets and theme classes are mirrored in; the frame fills its box.
 */
export function DeviceFrame({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  // The hero board is drawn under CSS `zoom` (see the engine's .board). A frame under a zoomed
  // ancestor is laid out by WebKit at the zoomed width while its `innerWidth` and the app's
  // own media queries disagree, so the app reflowed for a width it does not have (cropped
  // bubbles, wrong mode). The frame is therefore drawn at zoom 1 (its zoom undone, its box
  // shrunk by the same factor) and scaled back up by a transform: the same box on screen, laid
  // out at exactly its device width in every engine.
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    const apply = () => {
      let zoom = 1;
      for (let node: HTMLElement | null = frame.parentElement; node; node = node.parentElement) zoom *= Number.parseFloat(getComputedStyle(node).zoom) || 1;
      const next = zoom === 1
        ? { zoom: "", inlineSize: "", blockSize: "", transform: "", transformOrigin: "" }
        : { zoom: String(1 / zoom), inlineSize: `${100 / zoom}%`, blockSize: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: "0 0" };
      for (const key of Object.keys(next) as Array<keyof typeof next>) if (frame.style[key] !== next[key]) frame.style[key] = next[key];
    };
    apply();
    // The engine sets a tile's own zoom (the finale's fit) after its children mount, so follow it.
    const watch = new MutationObserver(apply);
    watch.observe(frame.closest("[data-slot=\"foundation-hero\"]") ?? document.body, { attributes: true, attributeFilter: ["style"], subtree: true });
    const frames = [requestAnimationFrame(() => requestAnimationFrame(apply))];
    return () => {
      watch.disconnect();
      for (const id of frames) cancelAnimationFrame(id);
    };
  }, []);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    let observers: MutationObserver[] = [];
    const setUp = () => {
      const doc = frame.contentDocument;
      // The srcdoc document, not the blank one the frame starts with.
      if (!doc?.body || doc.URL !== "about:srcdoc" || doc.body.dataset.ready !== undefined) return;
      doc.body.dataset.ready = "";
      for (const node of document.head.childNodes) if (isSheet(node)) doc.head.append(copySheet(node));
      const sync = () => {
        // The theme classes on the root too, so the frame's canvas is the window's own (light or dark).
        const theme = [...document.body.classList].filter((name) => name.startsWith("theme-")).join(" ");
        doc.documentElement.className = `${document.documentElement.className} ${theme} ${s.deviceRoot}`;
        doc.documentElement.lang = document.documentElement.lang;
        doc.documentElement.style.colorScheme = getComputedStyle(document.body).colorScheme;
        doc.body.className = `${document.body.className} ${s.deviceBody}`;
        if (document.body.dataset.motion) doc.body.dataset.motion = document.body.dataset.motion;
      };
      sync();
      const sheets = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (isSheet(node)) doc.head.append(copySheet(node));
      });
      sheets.observe(document.head, { childList: true });
      const classes = new MutationObserver(sync);
      classes.observe(document.body, { attributes: true, attributeFilter: ["class", "data-motion"] });
      classes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "lang"] });
      observers = [sheets, classes];
      setBody(doc.body);
    };
    frame.addEventListener("load", setUp);
    setUp();
    return () => {
      frame.removeEventListener("load", setUp);
      for (const observer of observers) observer.disconnect();
    };
  }, []);
  return (
    <>
      <iframe aria-hidden="true" className={s.frame} ref={ref} srcDoc={DOC} tabIndex={-1} title={label} />
      {body ? createPortal(children, body) : null}
    </>
  );
}
