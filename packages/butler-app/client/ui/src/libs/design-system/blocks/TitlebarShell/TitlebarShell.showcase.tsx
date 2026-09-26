import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { GitBranch, Minus, MoreHorizontal, PanelLeft, PanelRight, Square, X } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { TitlebarShell } from "./TitlebarShell";
import styles from "./TitlebarShell.module.css";

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
  },
  "ko-KR": {
    title: "토큰 페이지 검토", project: "butler", branch: "ui/ds-viewer-complete", showLeft: "왼쪽 패널 보기",
    showRight: "오른쪽 패널 보기", menu: "세션 작업", minimize: "창 최소화", maximize: "창 최대화", close: "창 닫기",
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
        className={styles.fixtureTitlebar}
        collapsed
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

export const stories: ShowcaseStory[] = [
  { name: "Collapsed sidebar (macOS)", widths: ["375", "app", "wide"], render: (context) => <Titlebar context={context} /> },
  { name: "Windows controls", widths: ["app", "wide"], render: (context) => <Titlebar context={context} windows /> },
];
