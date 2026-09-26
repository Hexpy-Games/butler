import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { MoreHorizontal, Notebook } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { SessionRow } from "./SessionRow";

export const meta: ShowcaseMeta = {
  title: "SessionRow",
  category: "Navigation",
  tags: ["sidebar", "session", "row", "density"],
  status: "beta",
};

const labels = {
  "en-US": {
    menu: "Session menu", active: "Design-system expansion", long: "A much longer conversation title that truncates in the tree",
    recent: "Release checklist review for the desktop client", project: "butler · Desktop client polish", when: "5 min ago",
  },
  "ko-KR": {
    menu: "세션 메뉴", active: "디자인 시스템 확장", long: "트리에서 말줄임되는 훨씬 긴 대화 제목입니다",
    recent: "데스크톱 클라이언트 릴리스 체크리스트 검토", project: "butler · 데스크톱 다듬기", when: "5분 전",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const menu = (label: string) => <IconButton label={label} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>;

export const stories: ShowcaseStory[] = [
  {
    // Tree rows are one line; Recent and Running rows add a description and time.
    name: "Tree and flat rows",
    widths: ["320", "375", "app"],
    render: (context) => {
      const copy = text(context);
      return (
        <Stack gap="xs">
          <SessionRow active icon={<Notebook />} title={copy.active} actions={menu(copy.menu)} onSelect={() => undefined} />
          <SessionRow icon={<Notebook />} title={copy.long} actions={menu(copy.menu)} onSelect={() => undefined} />
          <SessionRow title={copy.recent} description={copy.project} meta={copy.when} actions={menu(copy.menu)} onSelect={() => undefined} />
        </Stack>
      );
    },
  },
  {
    name: "Card variant",
    render: (context) => (
      <SessionRow card title={text(context).recent} description={text(context).project} meta={text(context).when} onSelect={() => undefined} />
    ),
  },
  {
    name: "Densities",
    render: (context) => (
      <Stack gap="sm">
        {(["compact", "comfortable", "touch"] as const).map((density) => (
          <SessionRow density={density} icon={<Notebook />} key={density} title={`${text(context).active} · ${density}`} onSelect={() => undefined} />
        ))}
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "selected"],
  render: (context) => (
    <SessionRow active={context.state === "selected"} actions={menu(text(context).menu)} icon={<Notebook />}
      meta={text(context).when} title={text(context).active} onSelect={() => undefined} />
  ),
};
