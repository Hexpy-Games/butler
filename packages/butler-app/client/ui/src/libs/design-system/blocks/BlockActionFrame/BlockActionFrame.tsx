import { useEffect, useId, useRef, useState, type HTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { Typo } from "../../components/Typo";
import { OverflowActionMenu, type OverflowActionMenuItem } from "../OverflowActionMenu";
import styles from "./BlockActionFrame.module.css";

export interface BlockActionFrameProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title"> {
  /** The block's title; without one the ⋯ floats on the block's top end corner. */
  title?: ReactNode;
  /** `block`: a block on its own (section title). `child`: a block inside a container (a smaller title). */
  level?: "block" | "child";
  /** The block's actions (서랍에 저장 · 문서로 만들기 · 복사); none: a plain titled block. */
  actions?: OverflowActionMenuItem[];
  /** The ⋯ button's accessible name. */
  actionsLabel?: string;
  children: ReactNode;
  /** The block's element (the save flight's source). */
  ref?: Ref<HTMLDivElement>;
}

/** A press held this long without moving opens the block's menu on touch. */
const LONG_PRESS_MS = 500;
/** Finger travel that turns a press into a scroll or drag. */
const LONG_PRESS_SLOP_PX = 10;
/** The innermost frame under each touch: frames see the same event inner first and only the first claims it. */
const touchOwners = new WeakMap<Event, string>();

/**
 * A touch long-press and a right-click open the actions of the innermost block only: the inner frame
 * claims the press (outer frames see it already claimed), and when its menu opens it cancels the press
 * for every ancestor (a pointercancel), so an enclosing long-press menu, such as the reply's, never opens too.
 */
function useBlockMenuGestures(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const clear = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => clear, []);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.pointerType === "mouse") return;
    if (!touchOwners.has(event.nativeEvent)) touchOwners.set(event.nativeEvent, id);
    if (touchOwners.get(event.nativeEvent) !== id) return;
    clear();
    const frame = event.currentTarget;
    const { clientX: x, clientY: y, pointerId } = event;
    press.current = { x, y, timer: window.setTimeout(() => {
      press.current = null;
      setOpen(true);
      frame.parentElement?.dispatchEvent(new window.PointerEvent("pointercancel", { bubbles: true, pointerId, pointerType: "touch" }));
    }, LONG_PRESS_MS) };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) clear();
  };
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (!enabled || event.defaultPrevented) return;
    event.preventDefault();
    setOpen(true);
  };
  return { open, setOpen, handlers: { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear, onContextMenu } };
}

/**
 * One content block (an answer block, a 서랍 block scrap, a document embed) with its title and a ⋯ menu.
 * The ⋯ shows on hover or keyboard focus, only on the innermost block under the pointer, so a container
 * and its child blocks never show two at once. A right-click, or a long-press on touch, opens the same
 * menu at the block's ⋯; on touch screens the ⋯ itself stays invisible.
 */
export function BlockActionFrame({ title, level = "block", actions = [], actionsLabel, children, className, ref, ...props }: BlockActionFrameProps) {
  const { open, setOpen, handlers } = useBlockMenuGestures(actions.length > 0);
  const heading = title
    ? level === "block" ? <Typo.SectionTitle>{title}</Typo.SectionTitle> : <Typo.Label as="div" weight="semibold">{title}</Typo.Label>
    : null;
  return (
    <div {...props} {...(actions.length ? handlers : {})} ref={ref} className={dsClass(styles.frame, className)} data-level={level}
      data-slot="block-action-frame" data-titled={title ? "true" : "false"}>
      {heading || actions.length ? (
        <div className={styles.header}>
          {heading}
          {actions.length ? <OverflowActionMenu className={dsClass(styles.trigger)} items={actions} label={actionsLabel} open={open} onOpenChange={setOpen} /> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
