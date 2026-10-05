import { useCallback } from "react";
import {
  AdaptiveShell,
  AdaptiveShellChrome,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
} from "../../../../blocks/AdaptiveShell";
import { ChromeFloatingToggleLayer } from "../../../../blocks/ChromeFrame";
import { ComposerCard, ComposerCardTextarea, ComposerCardInlineAction, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { ConversationScroll, ConversationShell } from "../../../../blocks/ConversationShell";
import { PillButton } from "../../../PillButton";
import { ButtonContainer } from "../../../ButtonContainer";
import { ScrollArea } from "../../../../blocks/ScrollArea";
import {
  PanelLeft, PanelLeftOpen, Plus } from "../../../Icons";
import { Stack } from "../../../Stack";
import type { LayoutCopy, Mode } from "./layoutCopy";

import { Sidebar } from "./Sidebar";
import { Titlebar } from "./Titlebar";
import { Turn } from "./LayoutTurn";

/** A conversation held at its latest message, as the app is when a chat is open: the bottom stays in view as the width reflows. */
function useLatestInView() {
  return useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined;
    const pin = () => { node.scrollTop = node.scrollHeight; };
    pin();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(pin) : null;
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => observer?.disconnect();
  }, []);
}

/**
 * Butler's app shell exactly as AppShell composes it (AdaptiveShell, the
 * space sidebar, the titlebar, the conversation and the floating composer),
 * held in one mode: expanded docks the sidebar; medium and compact put it in
 * a drawer (the layout AdaptiveShell picks below mediumMax in the browser),
 * full width on compact. `open` shows the drawer. The mode is fixed here
 * rather than read from the page's viewport, so a frame of whatever width on the
 * page lays out as the app does at that window width.
 */
export function AppScreen({ copy, mode, open = mode === "expanded", closedLook = !open, t }: {
  copy: LayoutCopy; mode: Mode; open?: boolean;
  /** Chrome drawn as with the sidebar closed (the drawer is opened by the timeline). */
  closedLook?: boolean;
  t?: (part: string) => string | undefined;
}) {
  const drawer = mode !== "expanded";
  const scrollRef = useLatestInView();
  return (
    <AdaptiveShell chromeEnvironment="browser" compactSidebarFullWidth data-panel-layout={drawer ? "drawer" : "docked"} data-screen={mode} leftOpen={open} rightOpen={false}>
      <AdaptiveShellSidebar data-t={t?.("side")} open={open}><Sidebar copy={copy} touch={mode === "compact"} /></AdaptiveShellSidebar>
      <AdaptiveShellWorkspace data-t={t?.("work")}>
        <Titlebar collapsed={closedLook} copy={copy} />
        <Stack fill gap="none">
          <ConversationShell composerReserve={96}>
            <ConversationScroll scrollRef={scrollRef} scrollable={false}><Turn copy={copy} /></ConversationScroll>
            <ComposerCard floating onSubmit={(event) => event.preventDefault()} controls={
      <ScrollArea orientation="x" flush><ButtonContainer size="sm" wrap={false} grow>
        <PillButton surface="glass" size="icon-lg" aria-label={copy.more}><Plus size="md" /></PillButton>
      </ButtonContainer></ScrollArea>
    }>
      <ComposerCardInlineAction action={<ComposerSendButton aria-label={copy.placeholder} disabled />}>
              <ComposerCardTextarea aria-label={copy.placeholder} placeholder={copy.placeholder} rows={1} />
      </ComposerCardInlineAction>

            </ComposerCard>
          </ConversationShell>
        </Stack>
      </AdaptiveShellWorkspace>
      {drawer ? <AdaptiveShellScrim label={copy.hide} onDismiss={() => undefined} open={open} /> : null}
      <AdaptiveShellChrome>
        <ChromeFloatingToggleLayer>
          <PillButton surface="glass" size="icon-lg" aria-label={closedLook ? copy.sidebar : copy.hide}>{closedLook ? <PanelLeft size="md" /> : <PanelLeftOpen size="md" />}</PillButton>
        </ChromeFloatingToggleLayer>
      </AdaptiveShellChrome>
    </AdaptiveShell>
  );
}
