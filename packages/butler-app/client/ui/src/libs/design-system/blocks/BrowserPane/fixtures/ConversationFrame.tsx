import { useRef, useState } from "react";
import { Box } from "../../../components/Box";
import { Button } from "../../../components/Button";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import {
  Clock3, Globe2, Library, MessageSquare, MoreHorizontal, PanelLeft, PanelRight, PencilLine, Search,
} from "../../../components/Icons";
import { Stack } from "../../../components/Stack";
import { Typo } from "../../../components/Typo";
import {
  AdaptiveShell, AdaptiveShellPeekEdge, AdaptiveShellSidebar, AdaptiveShellSplit, AdaptiveShellWorkspace, adaptivePanelStyle,
  useSidebarAutoCollapse, useSidebarPeek,
} from "../../AdaptiveShell";
import { ChromeFloatingToggleLayer } from "../../ChromeFrame";
import { NavRow } from "../../NavRow";
import { NavSection } from "../../NavSection";
import { SidebarBrand, SidebarShell, SidebarTrafficSpace } from "../../SidebarShell";
import { TitlebarShell } from "../../TitlebarShell";
import { Wallpaper } from "../../Wallpaper";
import { BrowserDemo, type BrowserDemoProps } from "./BrowserDemo";
import { BROWSER_DEMO_COPY } from "./copy";
import { ScaledFrame } from "./ScaledFrame";

type Locale = "en-US" | "ko-KR";

const SIDEBAR = {
  "en-US": { nav: ["New chat", "Search", "Schedules", "Browser", "Library"], spaces: "Spaces", rows: ["Office chair order", "Get the September invoice", "Pay the maintenance fee", "Weekly summary page"], show: "Show sidebar", inspector: "Show inspector", hide: "Hide browser", actions: "Conversation actions" },
  "ko-KR": { nav: ["새 대화", "검색", "예약 작업", "브라우저", "서랍"], spaces: "스페이스", rows: ["사무용 의자 주문", "9월 청구서 받기", "관리비 이체", "주간 요약 페이지"], show: "사이드바 보기", inspector: "인스펙터 보기", hide: "브라우저 닫기", actions: "대화 작업" },
} as const;

function DemoSidebar({ locale }: { locale: Locale }) {
  const copy = SIDEBAR[locale];
  const icons = [<PencilLine key="n" />, <Search key="s" />, <Clock3 key="c" />, <Globe2 key="g" />, <Library key="l" />];
  return (
    <SidebarShell ariaLabel="Sidebar" scrollFade={false} titlebar={<SidebarTrafficSpace />}
      header={<SidebarBrand><Typo.AppTitle>Butler</Typo.AppTitle></SidebarBrand>}>
      <Stack gap="lg">
        <Stack gap="xs">{copy.nav.map((label, index) => <NavRow key={label} icon={icons[index]} label={label} onClick={() => undefined} />)}</Stack>
        <NavSection title={copy.spaces}>
          {copy.rows.map((label, index) => <NavRow key={label} icon={<MessageSquare />} label={label} active={index === 0} onClick={() => undefined} />)}
        </NavSection>
      </Stack>
    </SidebarShell>
  );
}

function DemoChat({ locale, wallpaper = false }: { locale: Locale; wallpaper?: boolean }) {
  const [ask, answer, order] = BROWSER_DEMO_COPY[locale].chat;
  return (
    <Box padding="lg">
      {/* The conversation's wallpaper layer, workspace-scoped as the App renders it. */}
      {wallpaper ? <Wallpaper source={{ kind: "live", module: "butler.silk" }} /> : null}
      <div style={{ position: "relative" }}>
        <Stack gap="lg">
          <Stack align="row" justify="end"><Box surface="muted" radius="panel" padding="md"><Typo.Body>{ask}</Typo.Body></Box></Stack>
          <Typo.Body>{answer}</Typo.Body>
          <Stack align="row" justify="end"><Box surface="muted" radius="panel" padding="md"><Typo.Body>{order}</Typo.Body></Box></Stack>
        </Stack>
      </div>
    </Box>
  );
}

export interface ConversationFrameDemoProps extends Omit<BrowserDemoProps, "placement"> {
  width: number;
  height: number;
  /** `live-peek`: collapsed, and the left edge really peeks (useSidebarPeek); the button sends the host signal. */
  sidebar?: "open" | "collapsed" | "peek" | "live-peek";
  paneOpen?: boolean;
  /** Let the sidebar step aside when the page would be narrower than 720px. */
  autoCollapse?: boolean;
  /** The conversation's wallpaper behind the chat (contained to the chat column beside the pane). */
  wallpaper?: boolean;
}

/** The standalone Browser view: its title bar names the conversation that owns the tab (auto-sized leading). */
export function StandaloneFrameDemo({ width, height, ...browser }: Omit<ConversationFrameDemoProps, "sidebar" | "paneOpen">) {
  const demo = BROWSER_DEMO_COPY[browser.locale];
  return (
    <ScaledFrame width={width} height={height}>
      <AdaptiveShell leftOpen rightOpen={false} UNSAFE_style={{ height: "100%", ...adaptivePanelStyle({ leftWidth: 304, rightWidth: 376 }) }}>
        <AdaptiveShellSidebar open><DemoSidebar locale={browser.locale} /></AdaptiveShellSidebar>
        <AdaptiveShellWorkspace>
          <TitlebarShell title={demo.browser} dragRegion leadingSize="auto" dataTestClass="custom-titlebar"
            leading={<Button size="xs" variant="ghost" iconStart={<MessageSquare size="sm" />} text={demo.conversation} />} />
          <BrowserDemo {...browser} placement="standalone" />
        </AdaptiveShellWorkspace>
      </AdaptiveShell>
    </ScaledFrame>
  );
}

/** A whole window: sidebar, the conversation titlebar, chat | browser pane (AdaptiveShellSplit). */
export function ConversationFrameDemo({ width, height, sidebar = "open", paneOpen = true, autoCollapse = false, wallpaper = false, ...browser }: ConversationFrameDemoProps) {
  const copy = SIDEBAR[browser.locale];
  const demo = BROWSER_DEMO_COPY[browser.locale];
  const [chatWidth, setChatWidth] = useState(400);
  const shell = useRef<HTMLDivElement | null>(null);
  const collapsed = useSidebarAutoCollapse(shell, { enabled: paneOpen && autoCollapse, sidebarWidth: 304, chatWidth });
  const leftOpen = sidebar === "open" && !collapsed;
  const peek = useSidebarPeek(shell, { enabled: sidebar === "live-peek" });
  const browsing = browser.holder === undefined || browser.holder === "butler";
  const frame = (
    <ScaledFrame width={width} height={height}>
      <AdaptiveShell ref={shell} leftOpen={leftOpen} rightOpen={false} splitOpen={paneOpen} leftPeek={sidebar === "peek" || peek.open}
        UNSAFE_style={{ height: "100%", ...adaptivePanelStyle({ leftWidth: 304, rightWidth: 376 }) }}>
        {leftOpen ? null : (
          <ChromeFloatingToggleLayer>
            <IconButton label={copy.show}><PanelLeft size="md" /></IconButton>
          </ChromeFloatingToggleLayer>
        )}
        <AdaptiveShellSidebar open={leftOpen}><DemoSidebar locale={browser.locale} /></AdaptiveShellSidebar>
        {leftOpen ? null : <AdaptiveShellPeekEdge onPeek={peek.show} />}
        <AdaptiveShellWorkspace>
          <TitlebarShell title={demo.conversation} collapsed={!leftOpen} dragRegion dataTestClass="custom-titlebar"
            trailing={(
              <ButtonContainer size="icon-sm">
                <IconButton label={copy.actions} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>
                <IconButton label={paneOpen ? copy.hide : demo.browser} pressed={paneOpen} tone={browsing ? "riso" : paneOpen ? "butler" : "default"}
                  indicator={browsing && !paneOpen}><Globe2 size="md" /></IconButton>
                <IconButton label={copy.inspector}><PanelRight size="md" /></IconButton>
              </ButtonContainer>
            )} />
          <AdaptiveShellSplit paneOpen={paneOpen} chatWidth={chatWidth} onChatWidthChange={setChatWidth} resizeLabel={demo.resizeChat}
            chat={<DemoChat locale={browser.locale} wallpaper={wallpaper} />} pane={<BrowserDemo {...browser} placement="conversation" />} />
        </AdaptiveShellWorkspace>
      </AdaptiveShell>
    </ScaledFrame>
  );
  if (sidebar !== "live-peek") return frame;
  return (
    <Stack gap="sm">
      <Stack align="row" gap="sm" cross="center" wrap>
        <Button size="sm" variant="outline" text={demo.peekEdge} onClick={peek.show} />
        {/* Opens the peek, then reports what a host sees when the pointer moves onto a native page view. */}
        <Button size="sm" variant="outline" text={demo.nativePointer} data-ds-peek-host-signal=""
          onClick={() => { peek.show(); window.setTimeout(peek.pointerOutside, 600); }} />
        <Typo.Caption tone="secondary">{peek.open ? demo.peekOpen : demo.peekClosed}</Typo.Caption>
      </Stack>
      {frame}
    </Stack>
  );
}
