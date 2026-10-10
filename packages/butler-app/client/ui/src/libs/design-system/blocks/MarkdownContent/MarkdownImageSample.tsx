import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Expand, Save } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ArtifactPreviewImage } from "../ArtifactPreview";
import { MarkdownContent } from "./MarkdownContent";

const COPY = {
  "en-US": {
    route: "Here is the route: Ferry Building → Golden Gate Bridge → Sausalito, about 24 min (12.2 mi) via US-101.",
    routeAlt: "Map capture of the driving route", open: "Open", save: "Save",
    page: "The full page capture is tall, so it is shown at a bounded height.", pageAlt: "Full page capture",
    icon: "Small images keep their own size: the build", passed: "badge sits in the sentence.", iconAlt: "passing",
  },
  "ko-KR": {
    route: "경로를 짰습니다. 페리 빌딩 → 금문교 → 소살리토, US-101 경유 약 24분(12.2마일)입니다.",
    routeAlt: "자동차 경로 지도 캡처", open: "열기", save: "저장하기",
    page: "페이지 전체 캡처는 세로로 길어서 높이를 제한해 보여 줍니다.", pageAlt: "페이지 전체 캡처",
    icon: "작은 이미지는 원래 크기를 지킵니다. 빌드", passed: "배지가 문장 안에 놓입니다.", iconAlt: "통과",
  },
} as const;

function svg(width: number, height: number, body: string) {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  )}`;
}

/** A 2x browser capture: a directions panel beside a map with a route. */
const ROUTE_CAPTURE = svg(1600, 1000, [
  "<rect width='1600' height='1000' fill='#a9d3e6'/>",
  "<path d='M520 0h560c-40 120 30 260-20 380s-150 170-110 300 160 220 140 320H520Z' fill='#e8eadf'/>",
  "<path d='M1180 520c90-40 200-20 260 50s40 170-60 210-220-20-250-110 0-130 50-150Z' fill='#e8eadf'/>",
  "<path d='M640 120c60 40 90 120 140 170s40 140 90 210 60 160 140 230 200 60 260 120' fill='none' stroke='#4b3fd8' stroke-width='12' stroke-linecap='round'/>",
  "<circle cx='640' cy='120' r='16' fill='#e2483d'/><circle cx='1470' cy='850' r='16' fill='#e2483d'/>",
  "<rect width='480' height='1000' fill='#ffffff'/>",
  ...[60, 130, 200].map((y) => `<rect x="40" y="${y}" width="400" height="44" rx="10" fill="#f1f3f4"/>`),
  "<rect x='40' y='300' width='400' height='120' rx='12' fill='#e8f0fe'/>",
  "<rect x='64' y='330' width='220' height='20' rx='6' fill='#1a73e8'/><rect x='64' y='370' width='300' height='14' rx='6' fill='#80868b'/>",
  ...[470, 530, 590, 650].map((y) => `<rect x="40" y="${y}" width="${y % 120 === 50 ? 340 : 280}" height="16" rx="6" fill="#bdc1c6"/>`),
].join(""));

/** A full-page capture: much taller than the reading column. */
const PAGE_CAPTURE = svg(900, 2700, [
  "<rect width='900' height='2700' fill='#f6f7f9'/><rect width='900' height='120' fill='#202124'/>",
  ...Array.from({ length: 14 }, (_, index) =>
    `<rect x="60" y="${200 + index * 180}" width="780" height="140" rx="16" fill="${index % 3 ? "#ffffff" : "#dfe7f5"}"/>`),
].join(""));

const BADGE = svg(88, 20, "<rect width='88' height='20' rx='4' fill='#2da44e'/><rect x='8' y='7' width='72' height='6' rx='3' fill='#ffffff'/>");

/** MessageInlineImage in a reply: the capture, then Open and Save under it. */
function ReplyCapture({ copy, src, alt }: { copy: (typeof COPY)[keyof typeof COPY]; src: string; alt: string }) {
  return (
    <Stack as="span" gap="xs" cross="start">
      <ArtifactPreviewImage alt={alt} src={src} onClick={() => undefined} />
      <ButtonContainer size="xs">
        <Button size="xs" variant="inline" iconStart={<Expand size="sm" />}>{copy.open}</Button>
        <Button size="xs" variant="inline" iconStart={<Save size="sm" />}>{copy.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}

export function MarkdownImageSample({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <MarkdownContent>
      <p>{copy.route}</p>
      <p><ReplyCapture copy={copy} src={ROUTE_CAPTURE} alt={copy.routeAlt} /></p>
      <p>{copy.page}</p>
      <p><ReplyCapture copy={copy} src={PAGE_CAPTURE} alt={copy.pageAlt} /></p>
      <p>{copy.icon} <img alt={copy.iconAlt} src={BADGE} /> {copy.passed}</p>
    </MarkdownContent>
  );
}
