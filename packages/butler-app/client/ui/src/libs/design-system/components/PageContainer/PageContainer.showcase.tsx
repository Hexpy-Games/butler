import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../Box";
import { Card } from "../Card";
import { Grid } from "../Grid";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { PageContainer, type PageContainerWidth } from "./PageContainer";

export const meta: ShowcaseMeta = {
  title: "PageContainer",
  category: "Layout",
  tags: ["layout", "page", "width", "gutter", "container query"],
  status: "beta",
};

const labels = {
  "en-US": { width: "width", main: "Remaining work", aside: "Important materials", metric: "Open work" },
  "ko-KR": { width: "너비", main: "남은 작업", aside: "중요 자료", metric: "열린 작업" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const widths: PageContainerWidth[] = ["narrow", "default", "full"];

export const stories: ShowcaseStory[] = [
  {
    name: "Widths",
    widths: ["app", "wide"],
    render: (context) => (
      <Stack gap="sm">
        {widths.map((width) => (
          <Box key={width} surface="muted" radius="control">
            <PageContainer width={width}>
              <Box border="hairline" radius="control" padding="sm" surface="raised">
                <Typo.Caption tone="secondary">{`${text(context).width}="${width}"`}</Typo.Caption>
              </Box>
            </PageContainer>
          </Box>
        ))}
      </Stack>
    ),
  },
  {
    name: "Container query",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <PageContainer gutter="none">
        <Stack gap="md">
          <Grid columns={{ base: "2", wide: "4" }} gap="sm">
            {[3, 7, 1, 12].map((value, index) => (
              <Card key={index}>
                <Stack gap="xs">
                  <Typo.MetricValue numeric="tabular">{value}</Typo.MetricValue>
                  <Typo.Caption tone="secondary">{text(context).metric}</Typo.Caption>
                </Stack>
              </Card>
            ))}
          </Grid>
          <Grid columns={{ base: "1", wide: "main-aside" }} gap="md">
            <Card><Typo.Body>{text(context).main}</Typo.Body></Card>
            <Card><Typo.Body>{text(context).aside}</Typo.Body></Card>
          </Grid>
        </Stack>
      </PageContainer>
    ),
  },
];
