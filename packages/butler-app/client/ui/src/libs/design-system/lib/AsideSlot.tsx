import { useRef, type ReactNode } from "react";
import { Presence } from "../components/Presence";
import { TintedGlass } from "../components/TintedGlass";
import type { AsideLayout } from "./asideLayout";
import { useComposedRefs } from "./composeRefs";
import { dsClass } from "./internal";
import { useScrollEdges } from "./useScrollEdges";
import styles from "./AsideSlot.module.css";

/** A block's aside content: a node, or a function of the layout (content drops its own cards on glass). */
export type AsideContent = ReactNode | ((layout: AsideLayout) => ReactNode);

export const hasAsideContent = (aside: AsideContent | undefined): boolean =>
  aside !== undefined && aside !== null && aside !== false;

/** One inline gutter of a `both-edges` scroller (0 for overlay scrollbars), published once for its CSS. */
function measureGutter(element: HTMLElement | null) {
  if (element) element.style.setProperty("--aside-gutter", `${(element.offsetWidth - element.clientWidth) / 2}px`);
}

/** The aside's scroller: symmetric gutters and ring room (AsideSlot.module.css), the shared edge fade. */
function AsideScroll({ slot, layout, children }: { slot: string; layout: AsideLayout; children: ReactNode }) {
  const ref = useComposedRefs<HTMLDivElement>(useScrollEdges("y"), measureGutter);
  return <div ref={ref} className={styles.scroll} data-slot={`${slot}-scroll`} data-layout={layout}>{children}</div>;
}

interface AsideSlotProps {
  aside: AsideContent | undefined;
  layout: AsideLayout | null;
  floatOpen: boolean;
  slot: string;
  label?: string;
  className: string;
  glassClassName: string;
}

/**
 * The aside of ConversationShell and ManagementPage: flat while docked, one TintedGlass panel while
 * floating, its content in a scroller of its own (the aside stays put while the page scrolls). Each
 * layout enters and leaves with the DS Presence fade, so opening, closing and a docked/floating flip
 * cross-fade on motion tokens (none under reduced motion). The last content stays for the exit after
 * the block stops passing it.
 */
export function AsideSlot({ aside, layout, floatOpen, slot, label, className, glassClassName }: AsideSlotProps) {
  const kept = useRef<AsideContent>(aside);
  if (hasAsideContent(aside)) kept.current = aside;
  const present = hasAsideContent(aside);
  const render = (at: AsideLayout) => (
    <AsideScroll slot={slot} layout={at}>{typeof kept.current === "function" ? kept.current(at) : kept.current}</AsideScroll>
  );
  return (
    <>
      <Presence present={present && layout === "docked"} motion="fade">
        <aside className={className} data-slot={slot} data-layout="docked" aria-label={label}>{render("docked")}</aside>
      </Presence>
      <Presence present={present && layout === "floating" && floatOpen} motion="fade">
        <aside className={className} data-slot={slot} data-layout="floating" aria-label={label}>
          <TintedGlass className={dsClass(glassClassName)} radius="popover" padding="none">{render("floating")}</TintedGlass>
        </aside>
      </Presence>
    </>
  );
}
