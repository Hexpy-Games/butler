import { useRef, type ReactNode } from "react";
import { Presence } from "../components/Presence";
import { TintedGlass } from "../components/TintedGlass";
import type { AsideLayout } from "./asideLayout";
import { useComposedRefs } from "./composeRefs";
import { dsClass } from "./internal";
import { publishScrollbarWidth } from "./scrollbarWidth";
import { useScrollEdges } from "./useScrollEdges";
import styles from "./AsideSlot.module.css";

/** A block's aside content: a node, or a function of the layout (content drops its own cards on glass). */
export type AsideContent = ReactNode | ((layout: AsideLayout) => ReactNode);

export const hasAsideContent = (aside: AsideContent | undefined): boolean =>
  aside !== undefined && aside !== null && aside !== false;

/** The aside's scroller: a scrollbar lane only while one is drawn, ring room (AsideSlot.module.css), the shared edge fade. */
function AsideScroll({ slot, layout, children }: { slot: string; layout: AsideLayout; children: ReactNode }) {
  const ref = useComposedRefs<HTMLDivElement>(useScrollEdges("y"), publishScrollbarWidth);
  return (
    <div ref={ref} className={styles.scroll} data-slot={`${slot}-scroll`} data-layout={layout}>
      <div className={styles.content}>{children}</div>
    </div>
  );
}

interface AsideSlotProps {
  aside: AsideContent | undefined;
  layout: AsideLayout | null;
  floatOpen: boolean;
  slot: string;
  label?: string;
  className: string;
  glassClassName: string;
  /** A layout's exit has ended and its aside unmounted. */
  onExitComplete?: () => void;
}

/**
 * The aside of ConversationShell and ManagementPage: flat while docked, one TintedGlass panel while
 * floating, its content in a scroller of its own (the aside stays put while the page scrolls). Each
 * layout enters and leaves with the DS Presence fade, so opening, closing and a docked/floating flip
 * cross-fade on motion tokens (none under reduced motion). The last content stays for the exit after
 * the block stops passing it; a leaving aside is inert, so only the open one takes focus, pointer and
 * the landmark while both are on screen.
 */
export function AsideSlot({ aside, layout, floatOpen, slot, label, className, glassClassName, onExitComplete }: AsideSlotProps) {
  const kept = useRef<AsideContent>(aside);
  if (hasAsideContent(aside)) kept.current = aside;
  const present = hasAsideContent(aside);
  const docked = present && layout === "docked";
  const floating = present && layout === "floating" && floatOpen;
  const render = (at: AsideLayout) => (
    <AsideScroll slot={slot} layout={at}>{typeof kept.current === "function" ? kept.current(at) : kept.current}</AsideScroll>
  );
  return (
    <>
      <Presence present={docked} motion="fade" onExitComplete={onExitComplete}>
        <aside className={className} data-slot={slot} data-layout="docked" aria-label={label} inert={!docked}>{render("docked")}</aside>
      </Presence>
      <Presence present={floating} motion="fade" onExitComplete={onExitComplete}>
        <aside className={className} data-slot={slot} data-layout="floating" aria-label={label} inert={!floating}>
          <TintedGlass className={dsClass(glassClassName)} radius="popover" padding="none">{render("floating")}</TintedGlass>
        </aside>
      </Presence>
    </>
  );
}
