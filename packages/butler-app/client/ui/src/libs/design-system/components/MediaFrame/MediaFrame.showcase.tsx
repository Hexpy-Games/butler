import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../Grid";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { BROKEN_PICTURE, fixturePicture } from "./fixtures";
import { ImageLoadDemo } from "./MediaFrame.demo";
import { MediaFrame, type MediaFrameAspect } from "./MediaFrame";

export const meta: ShowcaseMeta = {
  title: "MediaFrame",
  category: "Data display",
  tags: ["image", "picture", "media", "aspect", "matte", "thumbnail"],
  status: "beta",
};

const COPY = {
  "en-US": {
    paper: "A paper's first page", place: "A lake trail", recipe: "A rice bowl", product: "A kettle", library: "A code library",
    fill: "Typical shape: spans the frame", strip: "Heading strip: inset on the matte", column: "Tall column: inset on the matte",
    empty: "No picture: the empty matte", failed: "Load error: the same matte",
    small: "Small picture (120 × 80): stays small", large: "Large picture (2× screenshot, 3000 × 2000 px): fits the column", half: "In a narrow column: capped at the column",
  },
  "ko-KR": {
    paper: "논문 첫 페이지", place: "호숫가 산책로", recipe: "비빔밥 한 그릇", product: "전기 주전자", library: "코드 라이브러리",
    fill: "보통 모양: 틀을 채움", strip: "가로 띠: 매트 안쪽에", column: "세로 기둥: 매트 안쪽에",
    empty: "사진 없음: 빈 매트", failed: "불러오기 실패: 같은 매트",
    small: "작은 사진(120 × 80): 작은 그대로", large: "큰 사진(2배 스크린숏, 3000 × 2000 px): 칸에 맞게", half: "좁은 칸 안: 칸 폭까지",
  },
} as const;

function Framed({ caption, ...props }: { caption: string; src?: string; aspect?: MediaFrameAspect }) {
  return (
    <Stack gap="xs">
      <MediaFrame {...props} alt={caption} />
      <Typo.Caption tone="secondary">{caption}</Typo.Caption>
    </Stack>
  );
}

function Shapes({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <Grid columns={{ base: "3", compact: "2" }} gap="md">
      <Framed caption={`1:1 · ${copy.library}`} aspect="1:1" src={fixturePicture("library")} />
      <Framed caption={`4:5 · ${copy.product}`} aspect="4:5" src={fixturePicture("product")} />
      <Framed caption={`3:4 · ${copy.paper}`} aspect="3:4" src={fixturePicture("paper")} />
      <Framed caption={`16:10 · ${copy.place}`} aspect="16:10" src={fixturePicture("place")} />
      <Framed caption={`16:9 · ${copy.recipe}`} aspect="16:9" src={fixturePicture("recipe")} />
    </Grid>
  );
}

function Fit({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <Grid columns={{ base: "3", compact: "1" }} gap="md">
      <Framed caption={copy.fill} src={fixturePicture("product")} />
      <Framed caption={copy.strip} src={fixturePicture("strip")} />
      <Framed caption={copy.column} src={fixturePicture("column")} />
    </Grid>
  );
}

function Missing({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <Grid columns={{ base: "3", compact: "2" }} gap="md">
      <Framed caption={copy.empty} aspect="4:5" />
      <Framed caption={copy.failed} aspect="4:5" src={BROKEN_PICTURE} />
    </Grid>
  );
}


/** Natural size: the frame takes the picture's own shape and never grows past its display width. */
function Natural({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <Stack gap="lg">
      <Stack gap="xs"><MediaFrame src={fixturePicture("product")} natural={{ width: 120, height: 80 }} /><Typo.Caption>{copy.small}</Typo.Caption></Stack>
      <Stack gap="xs"><MediaFrame src={fixturePicture("place")} natural={{ width: 1500, height: 1000 }} /><Typo.Caption>{copy.large}</Typo.Caption></Stack>
      <Grid columns="2" gap="md">
        <Stack gap="xs"><MediaFrame src={fixturePicture("place")} natural={{ width: 1500, height: 1000 }} /><Typo.Caption>{copy.half}</Typo.Caption></Stack>
        <Stack gap="xs"><MediaFrame src={fixturePicture("product")} natural={{ width: 120, height: 80 }} /><Typo.Caption>{copy.small}</Typo.Caption></Stack>
      </Grid>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Shapes: 1:1, 4:5, 3:4, 16:10, 16:9", render: (context) => <Shapes {...context} /> },
  { name: "Fit: typical pictures span, extreme ones sit inset", render: (context) => <Fit {...context} /> },
  { name: "Empty and failed: the matte keeps the shape", render: (context) => <Missing {...context} /> },
  { name: "Natural size: small stays small, large fits", widths: ["375", "app"], render: (context) => <Natural {...context} /> },
  { name: "Image load: the picture fades in over the matte", widths: ["375", "app"], render: (context) => <ImageLoadDemo {...context} /> },
  {
    name: "Reduced motion: the picture appears at once",
    widths: ["375", "app"],
    render: (context) => <ImageLoadDemo {...context} reducedMotion />,
  },
];
