import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ActivityStrip } from "./ActivityStrip";

export const meta: ShowcaseMeta = {
  title: "ActivityStrip",
  category: "Dashboard & Metrics",
  tags: ["activity", "days", "timeline", "sparkline"],
  status: "beta",
};

const ACTIVE = [1, 2, 5, 9, 10, 13];

function days(locale: ShowcaseRenderContext["locale"]) {
  const format = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 13 + index));
    return { key: String(index), label: format.format(date), active: ACTIVE.includes(index) };
  });
}

export const stories: ShowcaseStory[] = [
  {
    name: "Two weeks of changes",
    widths: ["375", "app"],
    render: (context) => {
      const list = days(context.locale);
      return (
        <Stack gap="xs">
          <Typo.Caption>{context.locale === "ko-KR" ? "변경 6회" : "6 changes"}</Typo.Caption>
          <ActivityStrip days={list} ariaLabel={list.filter((day) => day.active).map((day) => day.label).join(", ")} />
        </Stack>
      );
    },
  },
];
