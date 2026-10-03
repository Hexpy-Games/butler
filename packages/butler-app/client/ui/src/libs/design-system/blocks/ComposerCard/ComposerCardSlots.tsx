import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
