import { useRef, type ReactNode } from "react";
import { Download, History, MessageSquare, IconButton, Inline, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, type OverflowActionMenuItem } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { DocumentExportMenu, useDocumentExport } from "./DocumentExportMenu";
import type { EditableDocument } from "./documentApi";

type Props = {
  chatId?: string | null; historyOpen: boolean; setHistoryOpen: (open: boolean) => void;
  prepare: () => Promise<EditableDocument>;
};

/** Share actions and a single history surface across the inline row and overflow menu. */
export function useDocumentActions({ chatId, historyOpen, setHistoryOpen, prepare }: Props) {
  const copy = appCopy.documents;
  const menuRef = useRef<HTMLDivElement>(null), inlineRef = useRef<HTMLButtonElement>(null);
  const fromMenu = useRef(false);
  const menuButton = () => menuRef.current?.querySelector("button");
  const visibleAnchor = () => inlineRef.current?.getClientRects().length ? inlineRef.current : menuButton();
  const anchor = useRef({ getBoundingClientRect: () => visibleAnchor()?.getBoundingClientRect() ?? new DOMRect() });
  const { start, portal } = useDocumentExport(prepare);
  const openChat = () => { if (chatId) useButlerStore.getState().openSession(chatId); };
  const menuActions: OverflowActionMenuItem[] = [
    { icon: <History size="sm" />, label: copy.versions, onSelect: () => { fromMenu.current = true; setHistoryOpen(true); } },
    ...(chatId ? [{ icon: <MessageSquare size="sm" />, label: copy.originalChat, onSelect: openChat }] : []),
    { icon: <Download size="sm" />, label: copy.exportMarkdown, onSelect: () => start("markdown") },
    { icon: <Download size="sm" />, label: copy.exportPdf, onSelect: () => start("pdf") },
  ];
  const actions = <Inline gap="xs" wrap={false}>
    <PopoverTrigger asChild><IconButton ref={inlineRef} label={copy.versions} onClick={() => { fromMenu.current = false; }}><History size="sm" /></IconButton></PopoverTrigger>
    {chatId ? <IconButton label={copy.originalChat} onClick={openChat}><MessageSquare size="sm" /></IconButton> : null}
    <DocumentExportMenu start={start} />
  </Inline>;
  const wrap = (page: ReactNode, children: ReactNode) => <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
    {page}<PopoverAnchor virtualRef={anchor} />
    <PopoverContent align="end" onFocusOutside={event => {
      // Closing a dropdown can focus its exiting content before restoring its trigger.
      const trigger = menuButton();
      const closingMenu = event.target instanceof Element ? event.target.closest('[role="menu"][data-state="closed"]') : null;
      if (fromMenu.current && (event.target === trigger || (trigger && closingMenu?.getAttribute("aria-labelledby") === trigger.id))) event.preventDefault();
    }} onCloseAutoFocus={event => {
      // Focus returns after the exit animation; by then the user may have moved on (opened ⋯, clicked the text).
      const active = document.activeElement;
      if (active && active !== document.body && !(event.target instanceof Node && event.target.contains(active))) { event.preventDefault(); return; }
      if (fromMenu.current) menuButton()?.focus();
    }}>
      {children}
    </PopoverContent>
  </Popover>;
  return { layout: { actions, menuActions, menuLabel: copy.moreActions, menuRef }, wrap, portal };
}
