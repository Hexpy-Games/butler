import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { MessageSquarePlus, Popup, Trash2 } from "../../components/Icons";
import { cropImage, stripCrop, viewImage } from "../BrowserPane/fixtures/pages";
import { MetricCard } from "../MetricCard";
import { MetricGrid } from "../MetricGrid";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { StatusChecklist } from "../StatusChecklist";
import { LibraryCard, type LibraryCardMedia } from "./LibraryCard";

export const meta: ShowcaseMeta = {
  title: "LibraryCard",
  category: "Documents & Artifacts",
  tags: ["library", "scrap", "card", "grid", "media", "quote", "browser"],
  status: "beta",
};

const COPY = {
  "en-US": {
    element: "Element", view: "View", doc: "Document", block: "Block", spend: "Spending", income: "Income", steps: ["Book the venue", "Send invitations", "Order the cake"], blockTitles: ["This month", "Party checklist"], more: "More", attach: "Attach to chat", open: "Open source", remove: "Delete",
    tags: ["chairs", "office", "under 150k", "reviews"], select: "Select", name: "Name",
    crops: ["Office chairs (heading)", "128 items (a line)", "Filters (a column)", "Getting started (a view)", "Browser fixture (page title)"],
    items: [
      ["Lumbar height comes first", "desk.example.kr · Today", "“Adjust the lumbar height before the backrest angle.”"],
      ["Mesh Office Chair M2 · ₩129,000", "shop.example.com · Today"], ["Air Mesh Chair · ₩139,000", "shop.example.com · Today"],
      ["Choosing a chair that protects your back", "desk.example.kr · Yesterday"], ["Cloudnest invoices", "console.example.net · 10/6"],
      ["Weekly summary", "Butler output · 10/5"], ["Getting started", "docs.example.com · 10/3"], ["Q3 report", "Files · 10/2"],
    ],
  },
  "ko-KR": {
    element: "요소", view: "화면", doc: "문서", block: "블록", spend: "지출", income: "수입", steps: ["장소 예약", "초대장 보내기", "케이크 주문"], blockTitles: ["이번 달", "파티 준비"], more: "더 보기", attach: "대화에 첨부", open: "원본 열기", remove: "삭제",
    tags: ["의자", "사무실", "15만원 이하", "후기"], select: "선택", name: "이름",
    crops: ["사무용 의자 (제목)", "128개 상품 (한 줄)", "필터 (세로 칸)", "Getting started (화면)", "Browser fixture (페이지 제목)"],
    items: [
      ["요추 지지대 높이 조절이 먼저", "desk.example.kr · 오늘", "“등받이 각도보다 요추 지지대의 높이 조절이 먼저입니다.”"],
      ["메쉬 사무용 의자 M2 · 129,000원", "shop.example.com · 오늘"], ["에어 메쉬 체어 · 139,000원", "shop.example.com · 오늘"],
      ["허리를 지키는 사무용 의자 고르는 법", "desk.example.kr · 어제"], ["Cloudnest 청구서 목록", "console.example.net · 10/6"],
      ["이번 주 요약", "버틀러 출력물 · 10/5"], ["Getting started", "docs.example.com · 10/3"], ["3분기 보고서", "파일 · 10/2"],
    ],
  },
} as const;

function cards({ locale }: ShowcaseRenderContext, count: number) {
  const copy = COPY[locale];
  const media: LibraryCardMedia[] = [
    { kind: "quote", text: copy.items[0][2] }, { kind: "image", src: cropImage(0) }, { kind: "image", src: cropImage(1) },
    { kind: "image", src: viewImage("article") }, { kind: "image", src: viewImage("console") }, { kind: "image", src: viewImage("docs") },
    { kind: "image", src: viewImage("docs") }, { kind: "document" },
  ];
  const tags = [copy.element, copy.element, copy.element, copy.view, copy.view, copy.view, copy.view, copy.doc];
  const menu = (
    <OverflowActionMenu label={copy.more} items={[
      { icon: <MessageSquarePlus size="sm" />, label: copy.attach, onSelect: () => undefined },
      { icon: <Popup size="sm" />, label: copy.open, onSelect: () => undefined },
      { icon: <Trash2 size="sm" />, label: copy.remove, onSelect: () => undefined, variant: "destructive" },
    ]} />
  );
  return copy.items.slice(0, count).map(([title, meta], index) => (
    <LibraryCard key={title} media={media[index]!} title={title} meta={meta} tag={tags[index]} menu={menu} selected={index === 1} onOpen={() => undefined} />
  ));
}

/** Tags (2 + “+N”), no tags, selection mode with two selected, a rename in place, a dragged card. */
function Organizing({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  const base = { meta: copy.items[1][1], tag: copy.element, selectLabel: copy.select, onSelectedChange: () => undefined, onOpen: () => undefined };
  return (
    <Grid columns="4" gap="md">
      <LibraryCard {...base} media={{ kind: "image", src: cropImage(0) }} title={copy.items[1][0]} tags={copy.tags} selectionMode selected />
      <LibraryCard {...base} media={{ kind: "image", src: cropImage(1) }} title={copy.items[2][0]} tags={copy.tags.slice(0, 1)} selectionMode selected />
      <LibraryCard {...base} media={{ kind: "quote", text: copy.items[0][2] }} title={copy.items[0][0]} selectionMode />
      <LibraryCard {...base} media={{ kind: "document" }} tag={copy.doc} title={copy.items[7][0]} tags={copy.tags.slice(2, 3)} />
      <LibraryCard {...base} media={{ kind: "image", src: viewImage("docs") }} title={copy.items[6][0]}
        editing={{ value: copy.items[6][0], label: copy.name, onCommit: () => undefined, onCancel: () => undefined }} />
      <LibraryCard {...base} media={{ kind: "image", src: viewImage("article") }} title={copy.items[3][0]} dragging />
    </Grid>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Organizing: tags, selection, rename, dragging", widths: ["app", "wide"], render: (context) => <Organizing {...context} /> },
  { name: "3-column grid", widths: ["app", "wide"], render: (context) => <Grid columns="3" gap="md">{cards(context, 6)}</Grid> },
  { name: "4-column grid", widths: ["app", "wide"], render: (context) => <Grid columns="4" gap="md">{cards(context, 8)}</Grid> },
  { name: "Phone: one column", widths: ["375"], render: (context) => <Grid columns="1" gap="md">{cards(context, 3)}</Grid> },
  {
    // Typical crops (a square card, a page view) span the slot; extreme ones (a page title at 3.75:1 as the
    // library smoke captures it, a heading strip, a line of text, a tall column) sit whole, inset on the matte.
    name: "Typical crops span the slot; strips and columns sit inset",
    widths: ["app", "wide"],
    render: ({ locale }) => {
      const copy = COPY[locale];
      const crops: Array<[string, string, string]> = [
        [cropImage(0), copy.items[1][0], copy.element], [viewImage("docs"), copy.crops[3], copy.view],
        [stripCrop("title"), copy.crops[4], copy.element], [stripCrop("heading", locale), copy.crops[0], copy.element],
        [stripCrop("line", locale), copy.crops[1], copy.element], [stripCrop("column", locale), copy.crops[2], copy.element],
      ];
      return (
        <Grid columns="4" gap="md">
          {crops.map(([src, title, tag]) => (
            <LibraryCard key={title} media={{ kind: "image", src }} title={title} meta="shop.example.com" tag={tag} onOpen={() => undefined} />
          ))}
        </Grid>
      );
    },
  },
  {
    // Block scraps render the block itself, scaled into the media box: theme and content stay live.
    name: "Block scraps",
    widths: ["375", "app", "wide"],
    render: ({ locale }) => {
      const copy = COPY[locale];
      const metrics = <MetricGrid><MetricCard label={copy.spend} value="₩1,240,000" change="+8%" trend="down" /><MetricCard label={copy.income} value="₩3,100,000" change="+2%" trend="up" /></MetricGrid>;
      const checklist = <StatusChecklist items={copy.steps.map((text, index) => ({ text, done: index === 0 }))} />;
      return (
        <Grid columns={{ compact: "1", base: "3" }} gap="md">
          <LibraryCard media={{ kind: "block", content: metrics }} title={copy.blockTitles[0]} meta="Butler · Today" tag={copy.block} onOpen={() => undefined} />
          <LibraryCard media={{ kind: "block", content: checklist }} title={copy.blockTitles[1]} meta="Butler · Today" tag={copy.block} onOpen={() => undefined} />
          <LibraryCard media={{ kind: "document" }} title={copy.items[7][0]} meta={copy.items[7][1]} tag={copy.doc} onOpen={() => undefined} />
        </Grid>
      );
    },
  },
];
