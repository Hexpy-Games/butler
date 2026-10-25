import { useState } from "react";
import { Box } from "../../../components/Box";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import { AppleReminder, FileText, GitBranch, Globe2, MoreHorizontal, PanelLeft } from "../../../components/Icons";
import { Stack } from "../../../components/Stack";
import { Typo } from "../../../components/Typo";
import { dsClass } from "../../../lib/internal";
import { AdaptiveShell, AdaptiveShellCard, AdaptiveShellSidebar, AdaptiveShellSplit, AdaptiveShellTitle, AdaptiveShellWorkspace, adaptivePanelStyle } from "../../AdaptiveShell";
import { BrowserDemo } from "../../BrowserPane/fixtures/BrowserDemo";
import { DemoChat, DemoSidebar } from "../../BrowserPane/fixtures/ConversationFrame";
import { ScaledFrame } from "../../BrowserPane/fixtures/ScaledFrame";
import { ChromeFloatingToggleLayer } from "../../ChromeFrame";
import { TitlebarShell, type TitlebarShellProps } from "../TitlebarShell";
import styles from "../TitlebarShell.module.css";

type Locale = "en-US" | "ko-KR";

/** Which pane is open: the aside (세션 정보), the browser or the file viewer (both in the split's right region). */
export type DemoPane = "aside" | "browser" | "viewer";

const COPY = {
  "en-US": {
    title: "Shortcut conflicts", project: "Butler app", branch: "Local", menu: "Session actions", sessionInfo: "Session info",
    sessionInfoPending: "Session info · requests waiting for your answer", showBrowser: "Show browser", hideBrowser: "Hide browser",
    showSidebar: "Show sidebar", resize: "Resize conversation", dragToResize: "Drag to resize", viewer: "File viewer",
    file: "Release notes.md", fileMeta: "Markdown · 4 KB",
    fileBody: "Shortcut conflicts are listed by window. Each row names the two actions that share a key and the one that wins.",
  },
  "ko-KR": {
    title: "단축키 충돌 정리", project: "버틀러 앱", branch: "로컬", menu: "세션 작업", sessionInfo: "세션 정보",
    sessionInfoPending: "세션 정보 · 답을 기다리는 요청 있음", showBrowser: "브라우저 열기", hideBrowser: "브라우저 닫기",
    showSidebar: "사이드바 보기", resize: "대화 너비 조절", dragToResize: "드래그하여 크기 조절", viewer: "파일 보기",
    file: "릴리스 노트.md", fileMeta: "마크다운 · 4KB",
    fileBody: "단축키 충돌을 창별로 정리했습니다. 각 행에는 같은 키를 쓰는 두 동작과 우선하는 동작이 있습니다.",
  },
} as const;

/** The 세션 정보 toggle: AppleReminder; the dot (IconButton indicator) when a request waits, named in the label. */
function SessionInfoToggle({ locale, pending, open = false }: { locale: Locale; pending: boolean; open?: boolean }) {
  const copy = COPY[locale];
  return (
    <IconButton label={pending ? copy.sessionInfoPending : copy.sessionInfo} indicator={pending} pane="aside" pressed={open}
      tone={open ? "butler" : "default"}><AppleReminder size="md" /></IconButton>
  );
}

function BrowserToggle({ locale, open, onToggle }: { locale: Locale; open: boolean; onToggle?: () => void }) {
  const copy = COPY[locale];
  return (
    <IconButton label={open ? copy.hideBrowser : copy.showBrowser} pane="browser" pressed={open} tone={open ? "butler" : "default"} onClick={onToggle}>
      <Globe2 size="md" />
    </IconButton>
  );
}

/** The file viewer's toggle (shown while files are open): it fills with the viewer card's surface while docked. */
function ViewerToggle({ locale, open, onToggle }: { locale: Locale; open: boolean; onToggle?: () => void }) {
  return (
    <IconButton label={COPY[locale].viewer} pane="viewer" pressed={open} tone={open ? "butler" : "default"} onClick={onToggle}>
      <FileText size="md" />
    </IconButton>
  );
}

/** A card pane as the file viewer draws it: an AdaptiveShellCard holding the file's title and text. */
function DemoViewer({ locale }: { locale: Locale }) {
  const copy = COPY[locale];
  return (
    <AdaptiveShellCard className={dsClass(styles.fixturePane)}>
      <Box padding="2xl">
        <Stack gap="md">
          <Stack gap="none"><Typo.PanelTitle as="h2">{copy.file}</Typo.PanelTitle><Typo.Caption tone="secondary">{copy.fileMeta}</Typo.Caption></Stack>
          <Typo.Body>{copy.fileBody}</Typo.Body>
        </Stack>
      </Box>
    </AdaptiveShellCard>
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

/**
 * The bar alone: [title subtitle ⋯ ······ 세션 정보][browser]; `open` presses the 세션 정보 toggle. `viewer` adds the
 * file viewer's toggle before the browser's; `paneOpen` presses the viewer's or the browser's toggle.
 */
export function GroupedTitlebar({ locale, pending, open = false, viewer = false, paneOpen, className }: {
  locale: Locale; pending: boolean; open?: boolean; viewer?: boolean; paneOpen?: "browser" | "viewer";
  className?: TitlebarShellProps["className"];
}) {
  return (
    <TitlebarShell className={className} dragRegion {...conversationTitle(locale)}
      chatTrailing={<ButtonContainer size="icon-sm"><SessionInfoToggle locale={locale} pending={pending} open={open} /></ButtonContainer>}
      trailing={<ButtonContainer size="icon-sm">
        {viewer ? <ViewerToggle locale={locale} open={paneOpen === "viewer"} /> : null}
        <BrowserToggle locale={locale} open={paneOpen === "browser"} />
      </ButtonContainer>} />
  );
}

/**
 * A whole window (AdaptiveShell cards frame) with the split: the browser toggle opens and closes the pane and the
 * divider drags; the chat group follows the chat card in the same render. `pane="viewer"` puts the file viewer's
 * card in the right region instead, behind its own toggle.
 */
export function SplitWindowDemo({ locale, paneOpen: initialPaneOpen, sidebar = "open", pane = "browser" }: {
  locale: Locale; paneOpen: boolean; sidebar?: "open" | "collapsed"; pane?: "browser" | "viewer";
}) {
  const copy = COPY[locale];
  const [paneOpen, setPaneOpen] = useState(initialPaneOpen);
  const [chatWidth, setChatWidth] = useState(400);
  const leftOpen = sidebar === "open";
  const toggle = () => setPaneOpen((open) => !open);
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
              trailing={<ButtonContainer size="icon-sm">
                {pane === "viewer" ? <ViewerToggle locale={locale} open={paneOpen} onToggle={toggle} /> : null}
                <BrowserToggle locale={locale} open={pane === "browser" && paneOpen} onToggle={pane === "browser" ? toggle : undefined} />
              </ButtonContainer>} />
          </AdaptiveShellTitle>
          <AdaptiveShellSplit paneOpen={paneOpen} chatWidth={chatWidth} onChatWidthChange={setChatWidth} resizeLabel={copy.resize}
            resizeHint={copy.dragToResize} chat={<DemoChat locale={locale} />}
            pane={pane === "viewer" ? <DemoViewer locale={locale} />
              : <BrowserDemo locale={locale} placement="conversation" holder="user" band={null} pointer={false} agent={false} />} />
        </AdaptiveShellWorkspace>
      </AdaptiveShell>
    </ScaledFrame>
  );
}
