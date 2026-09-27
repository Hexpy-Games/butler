import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { EmptyLine } from "../../blocks/EmptyLine";
import { ListRow } from "../../blocks/ListRow";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { BookOpenText, Clock3, FileText, ListChecks, Plus } from "../Icons";
import { Stack } from "../Stack";
import { Section } from "./Section";

export const meta: ShowcaseMeta = {
  title: "Section",
  category: "Layout",
  tags: ["layout", "region", "inspector", "panel"],
  status: "stable",
};

const labels = {
  "en-US": {
    artifacts: "Artifacts", automations: "Automations", plans: "Plans", specs: "Specs", add: "New automation",
    description: "Files Butler created or changed in this conversation.", viewAll: "View all",
    items: ["release-notes.md", "design-review.png"], nightly: "Nightly release notes", every: "Every day 07:00",
    empty: "No specs yet.",
  },
  "ko-KR": {
    artifacts: "산출물", automations: "자동화", plans: "계획", specs: "명세", add: "새 자동화",
    description: "이 대화에서 Butler가 만들거나 바꾼 파일입니다.", viewAll: "모두 보기",
    items: ["release-notes.md", "design-review.png"], nightly: "야간 릴리스 노트", every: "매일 07:00",
    empty: "아직 명세가 없습니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Inspector section",
    render: (context) => (
      <Section title={text(context).artifacts} description={text(context).description} gap="md">
        {text(context).items.map((item) => <ListRow icon={<FileText size="md" />} key={item} title={item} />)}
      </Section>
    ),
  },
  {
    name: "With actions",
    render: (context) => (
      <Section
        actions={<IconButton label={text(context).add}><Plus size="md" /></IconButton>}
        gap="sm"
        title={text(context).automations}
      >
        <ListRow icon={<Clock3 size="md" />} meta={text(context).every} title={text(context).nightly} />
      </Section>
    ),
  },
  {
    name: "Icon title, empty state",
    render: (context) => (
      <Stack gap="2xl">
        <Section gap="lg" icon={<ListChecks size="md" />} title={text(context).plans}
          actions={<Button size="sm" variant="borderless" text={text(context).viewAll} />}>
          <ListRow title={text(context).nightly} />
        </Section>
        <Section gap="lg" icon={<BookOpenText size="md" />} title={text(context).specs}>
          <EmptyLine message={text(context).empty} />
        </Section>
      </Stack>
    ),
  },
];
