import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { Grid } from "../../components/Grid";
import { Typo } from "../../components/Typo";
import { DashboardHeader } from "../DashboardHeader";
import { ManagementPage } from "./ManagementPage";

export const meta: ShowcaseMeta = {
  title: "ManagementPage",
  category: "Shell",
  tags: ["shell", "page", "scroll", "dashboard", "page container"],
  status: "stable",
};

const labels = {
  "en-US": { title: "Automations", meta: "3 prompts scheduled", action: "New", main: "Scheduled prompts", aside: "Recent runs" },
  "ko-KR": { title: "자동화", meta: "예약된 프롬프트 3개", action: "새로 만들기", main: "예약된 프롬프트", aside: "최근 실행" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Page with main and aside",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <Box border="hairline" radius="panel">
        <ManagementPage dataTestClass="management-page-showcase">
          <DashboardHeader title={text(context).title} meta={text(context).meta}
            action={<Button variant="outline">{text(context).action}</Button>} />
          <Grid columns={{ base: "1", wide: "main-aside" }} gap="xl">
            <Box border="hairline" radius="control" padding="lg"><Typo.Body>{text(context).main}</Typo.Body></Box>
            <Box border="hairline" radius="control" padding="lg"><Typo.Body>{text(context).aside}</Typo.Body></Box>
          </Grid>
        </ManagementPage>
      </Box>
    ),
  },
];
