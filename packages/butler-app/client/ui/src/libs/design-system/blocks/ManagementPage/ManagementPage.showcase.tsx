import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { Grid } from "../../components/Grid";
import { Typo } from "../../components/Typo";
import { DashboardHeader } from "../DashboardHeader";
import { Wallpaper, type WallpaperSource } from "../Wallpaper";
import { ManagementPage, ManagementPagePanel, type ManagementPageBackgroundTreatment } from "./ManagementPage";
import styles from "./ManagementPage.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "ManagementPage",
  category: "Shell",
  tags: ["shell", "page", "scroll", "dashboard", "page container"],
  status: "stable",
};

const labels = {
  "en-US": {
    title: "Schedules", meta: "3 prompts scheduled", action: "New", main: "Scheduled prompts", aside: "Recent runs",
    project: "Butler", description: "Desktop client and gateway. Wallpaper upgrade in progress.",
    calm: "Calm treatment: the veil lowers the wallpaper's contrast.", none: "No treatment: the wallpaper as is.",
  },
  "ko-KR": {
    title: "예약 작업", meta: "예약된 프롬프트 3개", action: "새로 만들기", main: "예약된 프롬프트", aside: "최근 실행",
    project: "버틀러", description: "데스크톱 클라이언트와 게이트웨이. 월페이퍼 업그레이드 진행 중.",
    calm: "차분한 처리: 베일이 월페이퍼 대비를 낮춥니다.", none: "처리 없음: 월페이퍼 그대로.",
  },
} as const;

const BLOOM: WallpaperSource = { kind: "live", module: "butler.bloom", params: { colors: "aurora" } };

/** A dashboard over a container-scope wallpaper: header and content sit on glass panels. */
function WallpaperPage({ context, treatment }: { context: ShowcaseRenderContext; treatment: ManagementPageBackgroundTreatment }) {
  const copy = text(context);
  return (
    <div className={styles.stage}>
      <ManagementPage background={<Wallpaper scope="container" source={BLOOM} />} backgroundTreatment={treatment}
        dataTestClass="management-page-background-showcase">
        <ManagementPagePanel>
          <DashboardHeader title={copy.project} description={copy.description}
            action={<Button variant="outline">{copy.action}</Button>} />
        </ManagementPagePanel>
        <ManagementPagePanel>
          <Typo.Body>{treatment === "calm" ? copy.calm : copy.none}</Typo.Body>
          <Grid columns={{ base: "1", wide: "main-aside" }} gap="xl">
            <Box border="hairline" radius="control" padding="lg"><Typo.Body>{copy.main}</Typo.Body></Box>
            <Box border="hairline" radius="control" padding="lg"><Typo.Body>{copy.aside}</Typo.Body></Box>
          </Grid>
        </ManagementPagePanel>
      </ManagementPage>
    </div>
  );
}

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
  {
    name: "Page over a wallpaper",
    widths: ["375", "app", "wide"],
    render: (context) => <WallpaperPage context={context} treatment="calm" />,
  },
  {
    name: "Background without treatment",
    widths: ["app"],
    render: (context) => <WallpaperPage context={context} treatment="none" />,
  },
];
