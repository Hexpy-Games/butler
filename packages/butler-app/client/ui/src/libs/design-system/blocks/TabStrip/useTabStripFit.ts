import { useLayoutEffect, type RefObject } from "react";
import styles from "./TabStrip.module.css";

/** The shared tab width inside group pills, set on the scroller. */
const FIT_WIDTH = "--tab-strip-fit-width";

const px = (value: string) => parseFloat(value) || 0;
const part = (className: string | undefined) => `.${CSS.escape(className ?? "")}`;
const width = (node: Element | null) => (node ? node.getBoundingClientRect().width : 0);

/** The row's room for the scroller: the strip minus its other in-flow parts (new-tab button, trailing slot). */
function scrollerRoom(root: HTMLElement, scroller: HTMLElement) {
  const style = getComputedStyle(root);
  let room = root.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  for (const child of Array.from(root.children)) {
    if (child === scroller || getComputedStyle(child).position === "absolute") continue;
    room -= width(child) + px(style.columnGap);
  }
  return room;
}

/** A pill's own chrome (border, padding, title, + button, gaps) and its open tabs. Never reads the tabs' widths. */
function pillParts(pill: HTMLElement) {
  const style = getComputedStyle(pill);
  let chrome = px(style.borderLeftWidth) + px(style.borderRightWidth) + px(style.paddingLeft) + px(style.paddingRight)
    + width(pill.querySelector(part(styles.chipSlot)));
  const body = pill.querySelector<HTMLElement>(part(styles.foldBody));
  if (pill.hasAttribute("data-collapsed") || !body) return { chrome, tabs: [] as HTMLElement[] };
  const tabs = Array.from(body.querySelectorAll<HTMLElement>(part(styles.slot)));
  const plus = body.querySelector(part(styles.groupNew));
  const bodyStyle = getComputedStyle(body);
  const stops = tabs.length + (plus ? 1 : 0);
  chrome += px(bodyStyle.paddingLeft) + px(bodyStyle.paddingRight) + Math.max(0, stops - 1) * px(bodyStyle.columnGap) + width(plus);
  return { chrome, tabs };
}

/** Sets the one tab width that fits the open tabs of every pill into the row, between the min and max tokens. */
function fitTabs(root: HTMLElement, scroller: HTMLElement) {
  const style = getComputedStyle(scroller);
  const pills = Array.from(scroller.querySelectorAll<HTMLElement>(":scope > [data-titled]"));
  let room = scrollerRoom(root, scroller) - px(style.paddingLeft) - px(style.paddingRight)
    - Math.max(0, pills.length - 1) * px(style.columnGap);
  const tabs: HTMLElement[] = [];
  for (const pill of pills) {
    const parts = pillParts(pill);
    room -= parts.chrome;
    tabs.push(...parts.tabs);
  }
  if (tabs.length === 0) return;
  const min = px(style.getPropertyValue("--tab-strip-tab-min-width"));
  const max = px(style.getPropertyValue("--tab-strip-tab-max-width"));
  let share = room / tabs.length;
  // The selected tab keeps its larger minimum; the others share what is left.
  const active = tabs.find((tab) => tab.hasAttribute("data-active"));
  const activeMin = active ? px(getComputedStyle(active).minWidth) : 0;
  if (active && tabs.length > 1 && share < activeMin) share = (room - activeMin) / (tabs.length - 1);
  const next = `${Math.floor(Math.min(max, Math.max(min, share)))}px`;
  if (scroller.style.getPropertyValue(FIT_WIDTH) !== next) scroller.style.setProperty(FIT_WIDTH, next);
}

/**
 * Group pills keep their tabs in one row, so tabs in all pills share one measured width: the row's
 * room after each pill's chrome, divided by the open tabs. It is measured only in ResizeObserver
 * callbacks (the strip and each pill: a tab, a fold or a resize changes a pill's size), and the
 * chrome is read from the non-tab parts, so a fold's slide never makes it jitter. `pills` names the
 * pills shown (empty when the strip has none); flat strips shrink in CSS alone.
 */
export function useTabStripFit(root: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, pills: string) {
  useLayoutEffect(() => {
    const rootNode = root.current;
    const node = scroller.current;
    if (!rootNode || !node) return undefined;
    if (!pills) {
      node.style.removeProperty(FIT_WIDTH);
      return undefined;
    }
    const observer = new ResizeObserver(() => fitTabs(rootNode, node));
    observer.observe(rootNode);
    for (const pill of Array.from(node.querySelectorAll(":scope > [data-titled]"))) observer.observe(pill);
    return () => observer.disconnect();
  }, [root, scroller, pills]);
}
