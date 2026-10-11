import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { AttachmentList, type AttachmentListItem } from "../AttachmentList";
import { cropImage, stripCrop } from "../BrowserPane/fixtures/pages";
import { ElementChip } from "./ElementChip";

export const meta: ShowcaseMeta = {
  title: "ElementChip",
  category: "Composer",
  tags: ["attachment", "chip", "element", "pick", "composer", "message", "browser"],
  status: "beta",
};

const COPY = {
  "en-US": {
    chair: "Mesh Office Chair M2", air: "Air Mesh Chair", long: "Ergonomic mesh office chair with adjustable lumbar support", remove: "Remove",
    notes: "comparison-notes.md", heading: "Office chairs", line: "128 items · lowest price", column: "Filters",
  },
  "ko-KR": {
    chair: "메쉬 사무용 의자 M2", air: "에어 메쉬 체어", long: "요추 지지대 높이를 조절할 수 있는 인체공학 메쉬 사무용 의자", remove: "삭제",
    notes: "비교-메모.md", heading: "사무용 의자", line: "128개 상품 · 낮은 가격순", column: "필터",
  },
} as const;

function items({ locale }: ShowcaseRenderContext): AttachmentListItem[] {
  const copy = COPY[locale];
  return [
    { id: "e1", name: copy.chair, element: { site: "shop.example.com" }, thumbnail: { src: cropImage(0) } },
    { id: "e2", name: copy.air, element: { site: "shop.example.com" }, thumbnail: { src: cropImage(1) } },
    { id: "f1", name: copy.notes, meta: "4 KB", icon: <FileText size="sm" /> },
  ];
}

/** The composer's attachment row: element chips lead, files follow; both remove. */
function Composer(context: ShowcaseRenderContext) {
  const [list, setList] = useState(() => items(context));
  return <AttachmentList variant="chips" removeLabel={COPY[context.locale].remove} items={list} onRemove={(id) => setList(list.filter((item) => item.id !== id))} />;
}

export const stories: ShowcaseStory[] = [
  { name: "In the composer (AttachmentList chips)", widths: ["375", "app"], render: (context) => <Composer {...context} /> },
  { name: "In a sent message (read-only)", render: (context) => <AttachmentList items={items(context)} /> },
  {
    // Crops of block elements are the whole box: a heading is a wide strip with its words at the start. The
    // crop sits whole on the matte (never its blank middle); a missing crop shows the pick glyph.
    name: "Wide, tall and missing crops",
    render: ({ locale }) => (
      <Stack gap="sm" cross="start">
        <ElementChip src={stripCrop("heading", locale)} title={COPY[locale].heading} site="shop.example.com" removeLabel={COPY[locale].remove} onRemove={() => undefined} />
        <ElementChip src={stripCrop("line", locale)} title={COPY[locale].line} site="shop.example.com" removeLabel={COPY[locale].remove} onRemove={() => undefined} />
        <ElementChip src={stripCrop("column", locale)} title={COPY[locale].column} site="shop.example.com" />
        <ElementChip title={COPY[locale].chair} site="shop.example.com" />
      </Stack>
    ),
  },
  {
    name: "Long title at mobile width",
    widths: ["320", "375"],
    render: ({ locale }) => (
      <Stack gap="sm" cross="start">
        <ElementChip src={cropImage(0)} title={COPY[locale].long} site="shop.example.com" removeLabel={COPY[locale].remove} onRemove={() => undefined} />
        <ElementChip src={cropImage(1)} title={COPY[locale].long} site="shop.example.com" />
      </Stack>
    ),
  },
];
