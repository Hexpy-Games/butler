import { createContext } from "react";
import type { AsideLayout } from "../../lib/asideLayout";

/** The shell width from which the aside docks in the right margin (a floating one docks again 32px later). */
export const CONVERSATION_ASIDE_DOCK_MIN = 960;

/** Whether the shell's aside is docked: the column rect then reaches the aside's far edge. */
export const ConversationAsideDockedContext = createContext(false);

/** The shell's `data-aside`: `docked` moves the column; `floating` only while the glass panel shows. */
export function shownAside(hasAside: boolean, layout: AsideLayout | null, floatOpen: boolean): AsideLayout | undefined {
  if (!hasAside || layout === null) return undefined;
  return layout === "docked" || floatOpen ? layout : undefined;
}
