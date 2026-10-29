import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { GitBranch, Globe2, MessageSquare, Minus, MoreHorizontal, PanelLeft, PanelRight, Square, X } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { TitlebarShell } from "./TitlebarShell";
import { GroupedTitlebar, SplitWindowDemo } from "./fixtures/SplitTitlebarDemo";
import { PaneToggles } from "./fixtures/PaneTogglesDemo";
import styles from "./TitlebarShell.module.css";
import { dsClass } from "../../lib/internal";

export const meta: ShowcaseMeta = {
  title: "TitlebarShell",
  category: "Shell",
  tags: ["titlebar", "chrome", "window", "shell"],
  status: "stable",
};

const labels = {
  "en-US": {
    title: "Token page review", project: "butler", branch: "ui/ds-viewer-complete", showLeft: "Show left panel",
    showRight: "Show right panel", menu: "Session actions", minimize: "Minimize window", maximize: "Maximize window", close: "Close window",
    browser: "Browser", conversation: "Office chair order", openConversation: "Open conversation", browserActive: "Butler is browsing",
    nested: "Travel", back: "Back to Scraps",
  },
  "ko-KR": {
    title: "토큰 페이지 검토", project: "butler", branch: "ui/ds-viewer-complete", showLeft: "왼쪽 패널 보기",
    showRight: "오른쪽 패널 보기", menu: "세션 작업", minimize: "창 최소화", maximize: "창 최대화", close: "창 닫기",
    browser: "브라우저", conversation: "사무용 의자 주문", openConversation: "대화 열기", browserActive: "버틀러가 브라우저 사용 중",
    nested: "여행", back: "스크랩으로 돌아가기",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Titlebar: conversation title, workspace subtitle and trailing panel/menu buttons. */
function Titlebar({ context, windows }: { context: ShowcaseRenderContext; windows?: boolean }) {
  const copy = text(context);
  return (
    <div className={styles.fixture}>
      <TitlebarShell
        className={dsClass(styles.fixtureTitlebar)}
        collapsed
        dragRegion
        leading={<IconButton label={copy.showLeft}><PanelLeft size="md" /></IconButton>}
        title={copy.title}
        subtitle={(
          <Stack align="row" as="span" cross="center" gap="xs">
            <Typo.Caption tone="secondary">{copy.project}</Typo.Caption>
            <GitBranch size="sm" />
            <Typo.Caption tone="secondary">{copy.branch}</Typo.Caption>
          </Stack>
        )}
        trailing={(
          <ButtonContainer size="icon-sm">
            <IconButton label={copy.menu} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>
            <IconButton label={copy.showRight}><PanelRight size="md" /></IconButton>
          </ButtonContainer>
        )}
        windowControls={windows ? (
          <ButtonContainer size="icon-sm">
            <IconButton label={copy.minimize}><Minus size="md" /></IconButton>
            <IconButton label={copy.maximize}><Square size="md" /></IconButton>
            <IconButton label={copy.close}><X size="md" /></IconButton>
          </ButtonContainer>
        ) : undefined}
      />
    </div>
  );
}

/** Standalone browser: the conversation that owns the tab, as an auto-sized leading button. */
function ConversationLeading({ context, collapsed }: { context: ShowcaseRenderContext; collapsed: boolean }) {
  const copy = text(context);
  return (
    <div className={styles.fixture}>
      <TitlebarShell
        className={dsClass(collapsed ? styles.fixtureCollapsed : styles.fixtureTitlebar)}
        collapsed={collapsed}
        dragRegion
        leadingSize="auto"
        leading={<Button size="xs" variant="ghost" iconStart={<MessageSquare size="sm" />} text={copy.conversation}
          aria-label={`${copy.openConversation}: ${copy.conversation}`} />}
        title={copy.browser}
        trailing={(
          <ButtonContainer size="icon-sm">
            <IconButton label={copy.browserActive} tone="riso" indicator pressed={false}><Globe2 size="md" /></IconButton>
          </ButtonContainer>
        )}
      />
    </div>
  );
}

/** A nested screen (서랍 › 스크랩 › 여행): the back button goes up one level. */
function NestedTitle({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <div className={styles.fixture}>
      <TitlebarShell className={dsClass(styles.fixtureTitlebar)} dragRegion back={{ label: copy.back, onBack: () => undefined }} title={copy.nested} />
    </div>
  );
}

/** Title actions and chat trailing, pane closed: the 세션 정보 toggle without and with the attention dot (`open`: pressed). */
function GroupedTitlebars({ context, open = false }: { context: ShowcaseRenderContext; open?: boolean }) {
  return (
    <Stack gap="sm">
      {[false, true].map((pending) => (
        <div className={styles.fixture} key={String(pending)}>
          <GroupedTitlebar locale={context.locale} pending={pending} open={open} className={dsClass(styles.fixtureTitlebar)} />
        </div>
      ))}
    </Stack>
  );
}

// The first story is the Blocks gallery card, so it keeps the leading control of the default titlebar.
export const stories: ShowcaseStory[] = [
  { name: "Auto-sized leading control (sidebar open)", widths: ["375", "app", "wide"], render: (context) => <ConversationLeading context={context} collapsed={false} /> },
  { name: "Auto-sized leading control (sidebar collapsed)", widths: ["app", "wide"], render: (context) => <ConversationLeading context={context} collapsed /> },
  { name: "Collapsed sidebar (macOS)", widths: ["375", "app", "wide"], render: (context) => <Titlebar context={context} /> },
  { name: "Windows controls", widths: ["app", "wide"], render: (context) => <Titlebar context={context} windows /> },
  { name: "Nested screen: back button", widths: ["375", "app", "wide"], render: (context) => <NestedTitle context={context} /> },
  { name: "Title actions and chat trailing: session info without and with the dot", widths: ["375", "app", "wide"],
    render: (context) => <GroupedTitlebars context={context} /> },
  { name: "Session info open: the pressed toggle without and with the dot", states: ["pressed"], widths: ["375", "app", "wide"],
    render: (context) => <GroupedTitlebars context={context} open /> },
  { name: "Pane toggles: closed, then 세션 정보, the file viewer and the browser open (each fills with its pane's surface)",
    states: ["pressed"], widths: ["375", "app", "wide"], render: ({ locale }) => <PaneToggles locale={locale} /> },
  { name: "File viewer open: its toggle fills with the viewer card's surface", states: ["pressed"], widths: ["app", "wide"],
    render: ({ locale }) => <SplitWindowDemo locale={locale} paneOpen pane="viewer" /> },
  { name: "Browser split closed: chat trailing before the browser toggle", widths: ["app", "wide"],
    render: ({ locale }) => <SplitWindowDemo locale={locale} paneOpen={false} /> },
  { name: "Browser split open: the chat group spans the chat card (drag the divider)", widths: ["app", "wide"],
    render: ({ locale }) => <SplitWindowDemo locale={locale} paneOpen /> },
  { name: "Browser split open, sidebar collapsed", widths: ["app", "wide"],
    render: ({ locale }) => <SplitWindowDemo locale={locale} paneOpen sidebar="collapsed" /> },
];
