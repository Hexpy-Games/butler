import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { PanelLeft, PanelRightClose } from "../../components/Icons";
import { ChromeFloatingToggleLayer } from "../ChromeFrame";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ConversationFrameDemo } from "../BrowserPane/fixtures/ConversationFrame";
import {
  AdaptivePanelResizeHandle,
  AdaptivePanelTitlebar,
  AdaptiveShell,
  AdaptiveShellChrome,
  AdaptiveShellInspector,
  AdaptiveShellScrim,
  AdaptiveShellSidebar,
  AdaptiveShellWorkspace,
  adaptivePanelStyle,
} from "./index";

export const meta: ShowcaseMeta = {
  title: "AdaptiveShell",
  category: "Shell",
  tags: ["shell", "responsive", "drawer", "inspector", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    navigation: "Navigation", workspace: "Conversation", inspector: "Inspector", close: "Close",
    openNav: "Open navigation", openInspector: "Open inspector", scrim: "Close panel", resize: "Resize left sidebar",
    hint: "Below 768px the side panels become drawers over a scrim; at app width they sit beside the workspace.",
  },
  "ko-KR": {
    navigation: "내비게이션", workspace: "대화", inspector: "인스펙터", close: "닫기",
    openNav: "내비게이션 열기", openInspector: "인스펙터 열기", scrim: "패널 닫기", resize: "왼쪽 사이드바 크기 조절",
    hint: "768px 미만에서는 양쪽 패널이 스크림 위 드로어가 되고, 앱 너비에서는 작업 영역 옆에 놓입니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** AppShell composition in a bounded frame: sidebar, workspace, inspector, scrim. */
function ShellDemo({ context }: { context: ShowcaseRenderContext }) {
  const [panel, setPanel] = useState<"left" | "right" | null>("left");
  const copy = text(context);
  return (
    // Paint containment keeps the shell's fixed drawers inside the preview.
    <div style={{ height: 420, contain: "layout paint" }}>
      <AdaptiveShell compactSidebarFullWidth leftOpen={panel === "left"} rightOpen={panel === "right"}
        UNSAFE_style={{ height: "100%", ...adaptivePanelStyle({ leftWidth: 220, rightWidth: 260 }) }}>
        <AdaptiveShellChrome>
          <ChromeFloatingToggleLayer>
            <IconButton label={copy.openNav} onClick={() => setPanel(panel === "left" ? null : "left")}><PanelLeft size="md" /></IconButton>
          </ChromeFloatingToggleLayer>
        </AdaptiveShellChrome>
        <AdaptiveShellSidebar open={panel === "left"}>
          <Box padding="md">
            <Stack gap="sm">
              <Typo.PanelTitle>{copy.navigation}</Typo.PanelTitle>
              <Button size="sm" variant="outline" onClick={() => setPanel(null)} text={copy.close} />
            </Stack>
          </Box>
        </AdaptiveShellSidebar>
        <AdaptiveShellWorkspace>
          <Box padding="md">
            <Stack gap="sm">
              <Typo.AppTitle>{copy.workspace}</Typo.AppTitle>
              <Typo.Caption tone="secondary">{copy.hint}</Typo.Caption>
              <Stack align="row" gap="sm" wrap>
                <Button size="sm" onClick={() => setPanel("left")} text={copy.openNav} />
                <Button size="sm" variant="outline" onClick={() => setPanel("right")} text={copy.openInspector} />
              </Stack>
            </Stack>
          </Box>
        </AdaptiveShellWorkspace>
        {panel === "left" ? (
          <AdaptivePanelResizeHandle aria-label={copy.resize} aria-orientation="vertical" side="left"
            onKeyDown={() => undefined} onPointerDown={() => undefined} />
        ) : null}
        <AdaptiveShellInspector open={panel === "right"}>
          <AdaptivePanelTitlebar open>
            <IconButton label={copy.close} selected onClick={() => setPanel(null)}><PanelRightClose size="md" /></IconButton>
          </AdaptivePanelTitlebar>
          <Box padding="md"><Typo.PanelTitle>{copy.inspector}</Typo.PanelTitle></Box>
        </AdaptiveShellInspector>
        <AdaptiveShellScrim label={copy.scrim} open={panel !== null} onDismiss={() => setPanel(null)} />
      </AdaptiveShell>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Sidebar, workspace and inspector", states: ["open", "collapsed"], widths: ["375", "app", "wide"], render: (context) => <ShellDemo context={context} /> },
  {
    // AdaptiveShellSplit: chat | browser pane in the workspace's second row; drag or arrow-key the boundary (340–560px).
    name: "Conversation frame: chat | browser pane (resizable)",
    widths: ["app", "wide"],
    render: ({ locale }) => <ConversationFrameDemo locale={locale} width={1440} height={900} />,
  },
  {
    // AdaptiveShellPeekEdge: the collapsed sidebar floats over the workspace while the pointer is on it.
    name: "Sidebar peek",
    states: ["open"],
    widths: ["app", "wide"],
    render: ({ locale }) => <ConversationFrameDemo locale={locale} width={1100} height={800} sidebar="peek" />,
  },
  {
    // useSidebarAutoCollapse: 1100 − 304 − 400 leaves a 396px page, so the sidebar steps aside; at 1440 it stays.
    name: "Auto-collapse below a 720px page",
    states: ["collapsed"],
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Stack gap="md">
        <ConversationFrameDemo locale={locale} width={1440} height={700} autoCollapse />
        <ConversationFrameDemo locale={locale} width={1100} height={700} autoCollapse />
      </Stack>
    ),
  },
];
