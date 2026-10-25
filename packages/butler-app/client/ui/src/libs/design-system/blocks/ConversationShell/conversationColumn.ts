import { createContext, useContext } from "react";
import { useColumnRect, type ColumnRect } from "../../lib/columnRect";
import { ConversationAsideDockedContext } from "./conversationAside";

/**
 * The message column a conversation background keeps clear: the column's
 * left and right edges and the conversation's top, in client CSS px. The
 * composer shares the column's width, and a docked aside extends `right` to
 * its own far edge. Scrolling moves none of them.
 */
export type ConversationColumnRect = ColumnRect;

/** The shell's element, for the column's `top`. */
export const ConversationShellElementContext = createContext<HTMLElement | null>(null);

/**
 * Reports `column`'s rect once laid out and again only when it changes: on
 * column or shell resizes, window resizes and the aside docking or leaving
 * (the shared `useColumnRect`).
 */
export function useConversationColumnRect(column: HTMLElement | null, onColumnRect: ((rect: ConversationColumnRect) => void) | undefined) {
  const shell = useContext(ConversationShellElementContext);
  const docked = useContext(ConversationAsideDockedContext);
  useColumnRect(column, shell, docked ? "conversation-aside" : null, onColumnRect);
}
