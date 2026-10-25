import { useState } from "react";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import { AppleReminder, GitBranch, Globe2, MoreHorizontal, PanelLeft } from "../../../components/Icons";
import { Stack } from "../../../components/Stack";
import { Typo } from "../../../components/Typo";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellSplit, AdaptiveShellTitle, AdaptiveShellWorkspace, adaptivePanelStyle } from "../../AdaptiveShell";
import { BrowserDemo } from "../../BrowserPane/fixtures/BrowserDemo";
import { DemoChat, DemoSidebar } from "../../BrowserPane/fixtures/ConversationFrame";
import { ScaledFrame } from "../../BrowserPane/fixtures/ScaledFrame";
import { ChromeFloatingToggleLayer } from "../../ChromeFrame";
import { TitlebarShell, type TitlebarShellProps } from "../TitlebarShell";

type Locale = "en-US" | "ko-KR";

const COPY = {
  "en-US": {
    title: "Shortcut conflicts", project: "Butler app", branch: "Local", menu: "Session actions", sessionInfo: "Session info",
    sessionInfoPending: "Session info · requests waiting for your answer", showBrowser: "Show browser", hideBrowser: "Hide browser",
    showSidebar: "Show sidebar", resize: "Resize conversation", dragToResize: "Drag to resize",
  },
  "ko-KR": {
    title: "단축키 충돌 정리", project: "버틀러 앱", branch: "로컬", menu: "세션 작업", sessionInfo: "세션 정보",
    sessionInfoPending: "세션 정보 · 답을 기다리는 요청 있음", showBrowser: "브라우저 열기", hideBrowser: "브라우저 닫기",
    showSidebar: "사이드바 보기", resize: "대화 너비 조절", dragToResize: "드래그하여 크기 조절",
  },
} as const;

/** The 세션 정보 toggle: AppleReminder; the dot (IconButton indicator) when a request waits, named in the label. */
function SessionInfoToggle({ locale, pending, open = false }: { locale: Locale; pending: boolean; open?: boolean }) {
  const copy = COPY[locale];
  return (
    <IconButton label={pending ? copy.sessionInfoPending : copy.sessionInfo} indicator={pending} pressed={open}
      tone={open ? "butler" : "default"}><AppleReminder size="md" /></IconButton>
  );
}

function BrowserToggle({ locale, open, onToggle }: { locale: Locale; open: boolean; onToggle?: () => void }) {
  const copy = COPY[locale];
  return (
    <IconButton label={open ? copy.hideBrowser : copy.showBrowser} pressed={open} tone={open ? "butler" : "default"} onClick={onToggle}>
      <Globe2 size="md" />
    </IconButton>
  );
}

/** Title, the workspace subtitle and the ⋯ after them, as the conversation titlebar passes them. */
function conversationTitle(locale: Locale) {
  const copy = COPY[locale];
  return {
    title: copy.title,
    titleActions: <IconButton label={copy.menu} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>,
    subtitle: (
      <Stack align="row" as="span" cross="center" gap="xs">
        <Typo.Caption tone="secondary">{copy.project}</Typo.Caption>
        <GitBranch size="sm" />
        <Typo.Caption tone="secondary">{copy.branch}</Typo.Caption>
      </Stack>
    ),
  };
}

/** The bar alone, browser pane closed: [title subtitle ⋯ ······ 세션 정보][browser]; `open` presses the 세션 정보 toggle. */
export function GroupedTitlebar({ locale, pending, open = false, className }: {
  locale: Locale; pending: boolean; open?: boolean; className?: TitlebarShellProps["className"];
}) {
  return (
    <TitlebarShell className={className} dragRegion {...conversationTitle(locale)}
      chatTrailing={<ButtonContainer size="icon-sm"><SessionInfoToggle locale={locale} pending={pending} open={open} /></ButtonContainer>}
      trailing={<ButtonContainer size="icon-sm"><BrowserToggle locale={locale} open={false} /></ButtonContainer>} />
  );
}

/**
 * A whole window (AdaptiveShell cards frame) with the split: the browser toggle opens and closes the pane and the
 * divider drags; the chat group follows the chat card in the same render.
 */
export function SplitWindowDemo({ locale, paneOpen: initialPaneOpen, sidebar = "open" }: {
  locale: Locale; paneOpen: boolean; sidebar?: "open" | "collapsed";
}) {
  const copy = COPY[locale];
  const [paneOpen, setPaneOpen] = useState(initialPaneOpen);
  const [chatWidth, setChatWidth] = useState(400);
  const leftOpen = sidebar === "open";
  return (
    <ScaledFrame width={1440} height={420}>
      <AdaptiveShell frame="cards" leftOpen={leftOpen} rightOpen={false} splitOpen={paneOpen}
        UNSAFE_style={{ height: "100%", ...adaptivePanelStyle({ leftWidth: 304, rightWidth: 376 }) }}>
        {leftOpen ? null : (
          <ChromeFloatingToggleLayer>
            <IconButton label={copy.showSidebar}><PanelLeft size="md" /></IconButton>
          </ChromeFloatingToggleLayer>
        )}
        <AdaptiveShellSidebar open={leftOpen}><DemoSidebar locale={locale} collapsed={!leftOpen} /></AdaptiveShellSidebar>
        <AdaptiveShellWorkspace>
          <AdaptiveShellTitle>
            <TitlebarShell collapsed={!leftOpen} dragRegion dataTestClass="custom-titlebar" {...conversationTitle(locale)}
              chatTrailing={<ButtonContainer size="icon-sm"><SessionInfoToggle locale={locale} pending /></ButtonContainer>}
              splitChatWidth={paneOpen ? chatWidth : undefined}
              trailing={<ButtonContainer size="icon-sm"><BrowserToggle locale={locale} open={paneOpen} onToggle={() => setPaneOpen((open) => !open)} /></ButtonContainer>} />
          </AdaptiveShellTitle>
          <AdaptiveShellSplit paneOpen={paneOpen} chatWidth={chatWidth} onChatWidthChange={setChatWidth} resizeLabel={copy.resize}
            resizeHint={copy.dragToResize} chat={<DemoChat locale={locale} />}
            pane={<BrowserDemo locale={locale} placement="conversation" holder="user" band={null} pointer={false} agent={false} />} />
        </AdaptiveShellWorkspace>
      </AdaptiveShell>
    </ScaledFrame>
  );
}
