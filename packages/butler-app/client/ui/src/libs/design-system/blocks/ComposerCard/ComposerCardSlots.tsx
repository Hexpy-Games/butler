import { ComposerCardExpandedControls, ComposerCardToolbarSpacer } from "./ComposerCard";
import { Children, createContext, isValidElement, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TintedGlass } from "../../components/TintedGlass";
import { dsClass } from "../../lib/internal";
import styles from "./ComposerCard.module.css";

export const ComposerControlsVisible = createContext(true);

export const ComposerSlots = createContext<{
  toolbar: HTMLDivElement | null;
  action: HTMLDivElement | null;
  preview: HTMLDivElement | null;
} | undefined>(undefined);

/** Keep the original component tree, handlers and overlay anchors in DS-owned slots. */
export function ComposerSlot({ slot, children }: { slot: "toolbar" | "action" | "preview"; children: ReactNode }) {
  const slots = useContext(ComposerSlots);
  const visible = useContext(ComposerControlsVisible);
  if (!slots) return children;
  return slots[slot] ? createPortal(slot === "action" ? <span hidden={!visible}>{children}</span> : children, slots[slot]) : null;
}

export function ComposerControlPills({ children }: { children: ReactNode }) {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    // Layout components retain their flex behavior; each leaf control owns one surface.
    if (child.type === ComposerCardToolbarSpacer || child.type === ComposerCardExpandedControls) return child;
    return <TintedGlass padding="none" className={dsClass(styles.controlPill)} data-slot="composer-control-pill">{child}</TintedGlass>;
  });
}
