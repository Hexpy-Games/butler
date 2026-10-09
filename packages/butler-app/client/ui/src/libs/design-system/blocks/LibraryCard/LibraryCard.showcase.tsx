import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { MessageSquarePlus, Popup, Trash2 } from "../../components/Icons";
import { cropImage, stripCrop, viewImage } from "../BrowserPane/fixtures/pages";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { LibraryCard, type LibraryCardMedia } from "./LibraryCard";

export const meta: ShowcaseMeta = {
  title: "LibraryCard",
  category: "Documents & Artifacts",
  tags: ["library", "scrap", "card", "grid", "media", "quote", "browser"],
  status: "beta",
};

const COPY = {
  "en-US": {
    element: "Element", view: "View", doc: "Document", more: "More", attach: "Attach to chat", open: "Open source", remove: "Delete",
    crops: ["Office chairs (heading)", "128 items (a line)", "Filters (a column)", "Getting started (a view)", "Browser fixture (page title)"],
    items: [
      ["Lumbar height comes first", "desk.example.kr · Today", "“Adjust the lumbar height before the backrest angle.”"],
      ["Mesh Office Chair M2 · ₩129,000", "shop.example.com · Today"], ["Air Mesh Chair · ₩139,000", "shop.example.com · Today"],
      ["Choosing a chair that protects your back", "desk.example.kr · Yesterday"], ["Cloudnest invoices", "console.example.net · 10/6"],
      ["Weekly summary", "Butler output · 10/5"], ["Getting started", "docs.example.com · 10/3"], ["Q3 report", "Files · 10/2"],
    ],
  },
  "ko-KR": {
    element: "요소", view: "화면", doc: "문서", more: "더 보기", attach: "대화에 첨부", open: "원본 열기", remove: "삭제",
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

export const stories: ShowcaseStory[] = [
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
];
