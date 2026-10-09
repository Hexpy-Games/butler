import { Button } from "../../../components/Button";
import { ButtonContainer } from "../../../components/ButtonContainer";
import { IconButton } from "../../../components/IconButton";
import { Clock3, FileText, Globe2, ListFilter, MessageSquare, MoreHorizontal, PanelLeft, PanelRight } from "../../../components/Icons";
import { Switch } from "../../../components/Switch";
import { BrowserDemo } from "../../BrowserPane/fixtures/BrowserDemo";
import { DemoChat, DemoSidebar } from "../../BrowserPane/fixtures/ConversationFrame";
import { BROWSER_DEMO_COPY } from "../../BrowserPane/fixtures/copy";
import { ScaledFrame } from "../../BrowserPane/fixtures/ScaledFrame";
import { ChromeFloatingToggleLayer } from "../../ChromeFrame";
import { FormSection } from "../../FormSection";
import { InspectorPanel } from "../../InspectorPanel";
import { InspectorShell } from "../../InspectorShell";
import { ListRow } from "../../ListRow";
import { SettingsField } from "../../SettingsField";
import { SettingsHeader } from "../../SettingsHeader";
import { SettingsNav } from "../../SettingsNav";
import { SettingsShell } from "../../SettingsShell";
import { TitlebarShell } from "../../TitlebarShell";
import {
  AdaptiveShell, AdaptiveShellCard, AdaptiveShellInspector, AdaptiveShellSidebar, AdaptiveShellSplit, AdaptiveShellTitle,
  AdaptiveShellWorkspace, adaptivePanelStyle, type ShellFrame,
} from "../index";

type Locale = "en-US" | "ko-KR";
export type ShellFrameView = "chat" | "browser" | "inspector" | "settings" | "hub";

const COPY = {
  "en-US": {
    actions: "Conversation actions", showBrowser: "Show browser", hideBrowser: "Hide browser", showInspector: "Show inspector",
    hideInspector: "Hide inspector", showSidebar: "Show sidebar", summary: "Summary", artifacts: "Artifacts", schedules: "Schedules",
    progress: "Progress", step: "Find and order the chair", weekly: "Weekly summary", appearance: "Appearance", general: "General",
    appearanceDescription: "Theme and how the app looks.", translucent: "Translucent sidebar", smartGroups: "Smart groups",
  },
  "ko-KR": {
    actions: "대화 작업", showBrowser: "브라우저 열기", hideBrowser: "브라우저 닫기", showInspector: "인스펙터 보기",
    hideInspector: "인스펙터 숨기기", showSidebar: "사이드바 보기", summary: "요약", artifacts: "아티팩트", schedules: "예약 작업",
    progress: "진행 상황", step: "의자 찾아 주문하기", weekly: "주간 요약", appearance: "모양", general: "일반",
    appearanceDescription: "앱의 테마와 화면 표시 방식을 설정합니다.", translucent: "투명 사이드바", smartGroups: "스마트 그룹",
  },
} as const;

/** The conversation title row: ⋯, the browser toggle and the inspector toggle (on = icon colour, never a fill). */
function DemoTitle({ locale, view, leftOpen }: { locale: Locale; view: ShellFrameView; leftOpen: boolean }) {
  const copy = COPY[locale];
  const demo = BROWSER_DEMO_COPY[locale];
  const browserOn = view === "browser";
  const inspectorOn = view === "inspector";
  if (view === "hub") {
    return (
      <AdaptiveShellTitle>
        <TitlebarShell title={demo.browser} collapsed={!leftOpen} dragRegion leadingSize="auto" dataTestClass="custom-titlebar"
          leading={<Button size="xs" variant="ghost" iconStart={<MessageSquare size="sm" />} text={demo.conversation} />} />
      </AdaptiveShellTitle>
    );
  }
  return (
    <AdaptiveShellTitle>
      <TitlebarShell title={demo.conversation} collapsed={!leftOpen} dragRegion dataTestClass="custom-titlebar"
        trailing={(
          <ButtonContainer size="icon-sm" data-ds-title-icons="">
            <IconButton label={copy.actions} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>
            <IconButton label={browserOn ? copy.hideBrowser : copy.showBrowser} pressed={browserOn} tone={browserOn ? "butler" : "default"}>
              <Globe2 size="md" />
            </IconButton>
            <IconButton label={inspectorOn ? copy.hideInspector : copy.showInspector} pressed={inspectorOn} tone={inspectorOn ? "butler" : "default"}>
              <PanelRight size="md" />
            </IconButton>
          </ButtonContainer>
        )} />
    </AdaptiveShellTitle>
  );
}

function DemoInspector({ locale }: { locale: Locale }) {
  const copy = COPY[locale];
  return (
    <InspectorShell activeTab="summary" onTabChange={() => undefined} tabs={[
      { id: "summary", label: copy.summary, icon: <ListFilter size="md" /> },
      { id: "artifacts", label: copy.artifacts, icon: <FileText size="md" /> },
      { id: "schedules", label: copy.schedules, icon: <Clock3 size="md" /> },
    ]}>
      <InspectorPanel title={copy.progress}>
        <ListRow icon={<ListFilter size="md" />} title={copy.step} />
        <ListRow icon={<FileText size="md" />} title={copy.weekly} />
      </InspectorPanel>
    </InspectorShell>
  );
}

function DemoSettings({ locale }: { locale: Locale }) {
  const copy = COPY[locale];
  return (
    <SettingsShell active pageTitle={copy.appearance} pageDescription={copy.appearanceDescription} pageKey="appearance"
      sidebar={<SettingsNav items={[
        { id: "general", label: copy.general, active: false },
        { id: "appearance", label: copy.appearance, active: true },
      ]} />}
      detailHeader={<SettingsHeader title={copy.appearance} description={copy.appearanceDescription} />}
      detail={(
        <FormSection title={copy.appearance}>
          <SettingsField id={`${locale}-shell-translucent`} label={copy.translucent} control={<Switch id={`${locale}-shell-translucent`} defaultChecked />} />
          <SettingsField id={`${locale}-shell-groups`} label={copy.smartGroups} control={<Switch id={`${locale}-shell-groups`} />} />
        </FormSection>
      )} />
  );
}

export interface ShellFrameDemoProps {
  locale: Locale;
  frame: ShellFrame;
  width: number;
  height: number;
  view?: ShellFrameView;
  sidebar?: "open" | "collapsed" | "peek";
  /** The new-chat wallpaper: it lives inside the content card in the cards frame. */
  wallpaper?: boolean;
}

/** A whole window in either frame: the App's shell composition with viewer stand-ins for its content. */
export function ShellFrameDemo({ locale, frame, width, height, view = "chat", sidebar = "open", wallpaper = false }: ShellFrameDemoProps) {
  const geometry = { height: "100%", ...adaptivePanelStyle({ leftWidth: 304, rightWidth: 376 }) };
  if (view === "settings") {
    return (
      <ScaledFrame width={width} height={height}>
        <AdaptiveShell frame={frame} leftOpen rightOpen={false} settingsActive UNSAFE_style={geometry}>
          <DemoSettings locale={locale} />
        </AdaptiveShell>
      </ScaledFrame>
    );
  }
  const leftOpen = sidebar === "open";
  return (
    <ScaledFrame width={width} height={height}>
      <AdaptiveShell frame={frame} leftOpen={leftOpen} rightOpen={view === "inspector"} splitOpen={view === "browser"}
        leftPeek={sidebar === "peek"} transparentWorkspace={wallpaper} UNSAFE_style={geometry}>
        {leftOpen ? null : (
          <ChromeFloatingToggleLayer>
            <IconButton label={COPY[locale].showSidebar}><PanelLeft size="md" /></IconButton>
          </ChromeFloatingToggleLayer>
        )}
        <AdaptiveShellSidebar open={leftOpen}><DemoSidebar locale={locale} collapsed={!leftOpen} /></AdaptiveShellSidebar>
        <AdaptiveShellWorkspace>
          <DemoTitle locale={locale} view={view} leftOpen={leftOpen} />
          {view === "browser" ? (
            <AdaptiveShellSplit paneOpen chatWidth={400} chat={<DemoChat locale={locale} />}
              pane={<BrowserDemo locale={locale} placement="conversation" holder="user" band={null} pointer={false} agent={false} />} />
          ) : view === "hub" ? (
            <BrowserDemo locale={locale} placement="standalone" holder="none" band={null} pointer={false} agent={false} />
          ) : (
            <AdaptiveShellCard><DemoChat locale={locale} wallpaper={wallpaper} /></AdaptiveShellCard>
          )}
        </AdaptiveShellWorkspace>
        <AdaptiveShellInspector open={view === "inspector"}><DemoInspector locale={locale} /></AdaptiveShellInspector>
      </AdaptiveShell>
    </ScaledFrame>
  );
}
