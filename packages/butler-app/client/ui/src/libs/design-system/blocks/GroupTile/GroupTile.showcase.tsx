import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { FolderOpen, PencilLine, X } from "../../components/Icons";
import { cropImage, stripCrop, viewImage } from "../BrowserPane/fixtures/pages";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { GroupTile, GroupTileMore, type GroupTilePreview } from "./GroupTile";

export const meta: ShowcaseMeta = {
  title: "GroupTile",
  category: "Documents & Artifacts",
  tags: ["library", "group", "folder", "album", "mosaic", "drop", "browser"],
  status: "beta",
};

const COPY = {
  "en-US": {
    more: "More", open: "Open", rename: "Rename", ungroup: "Ungroup", empty: "Empty", viewAll: "View all", moreGroups: "3 more groups",
    names: ["Travel", "Camping gear", "Recipes", "Fall clothes", "Gift ideas", "Autumn month-long Jeju stay shortlist and neighborhood walks", "Work references"],
    scraps: (n: number) => `${n} scrap${n === 1 ? "" : "s"} · Oct 10`, drop: "Add to “Work references”",
    folders: ["Work", "Reading"], bookmarks: (n: number) => `${n} bookmarks · Oct 2`,
    quote: "Q4 goal: raise onboarding completion from 60% to 75%.",
  },
  "ko-KR": {
    more: "더 보기", open: "열기", rename: "이름 변경", ungroup: "그룹 해제", empty: "비어 있음", viewAll: "모두 보기", moreGroups: "그룹 3개 더",
    names: ["여행", "캠핑 장비", "레시피", "가을 옷", "선물 아이디어", "2026 가을 제주 한 달 살기 숙소 후보와 동네 산책 코스 모음", "업무 참고"],
    scraps: (n: number) => `스크랩 ${n}개 · 10. 10.`, drop: "‘업무 참고’에 넣기",
    folders: ["업무", "읽을거리"], bookmarks: (n: number) => `북마크 ${n}개 · 10. 2.`,
    quote: "Q4 목표: 신규 사용자 온보딩 완료율 60% → 75%.",
  },
} as const;

function previews(count: number, context: ShowcaseRenderContext): GroupTilePreview[] {
  const all: GroupTilePreview[] = [
    { kind: "image", src: cropImage(0) }, { kind: "image", src: viewImage("article") },
    { kind: "image", src: stripCrop("heading", context.locale) }, { kind: "image", src: cropImage(1) }, { kind: "image", src: viewImage("docs") },
  ];
  return all.slice(0, count);
}

function menu(context: ShowcaseRenderContext) {
  const copy = COPY[context.locale];
  return <OverflowActionMenu label={copy.more} items={[
    { icon: <FolderOpen size="sm" />, label: copy.open, onSelect: () => undefined },
    { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => undefined },
    { icon: <X size="sm" />, label: copy.ungroup, onSelect: () => undefined, variant: "destructive" },
  ]} />;
}

function States(context: ShowcaseRenderContext) {
  const copy = COPY[context.locale];
  const tile = (index: number, count: number, extra: { drop?: boolean; quote?: boolean } = {}) => (
    <GroupTile key={index} name={copy.names[index]!} meta={copy.scraps(count)} emptyLabel={copy.empty} menu={menu(context)}
      previews={extra.quote ? [{ kind: "quote", text: copy.quote }, { kind: "document" }] : previews(count, context)}
      drop={extra.drop} dropHint={copy.drop} onOpen={() => undefined} />
  );
  return (
    <Grid columns="4" gap="md">
      {tile(0, 5)}{tile(1, 3)}{tile(2, 2)}{tile(3, 1)}{tile(4, 0)}{tile(5, 4)}{tile(6, 2, { drop: true, quote: true })}
      <GroupTileMore count={3} label={copy.moreGroups} meta={copy.viewAll} onOpen={() => undefined} />
    </Grid>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "States: 4+, 3, 2, 1, empty, long name, drop target, overflow", widths: ["app", "wide"], render: (context) => <States {...context} /> },
  {
    name: "Bookmark folders (favicon and host)",
    widths: ["app", "wide"],
    render: (context) => {
      const copy = COPY[context.locale];
      return (
        <Grid columns="4" gap="md">
          <GroupTile name={copy.folders[0]} meta={copy.bookmarks(2)} emptyLabel={copy.empty} onOpen={() => undefined}
            previews={[{ kind: "site", host: "docs.example.com" }, { kind: "site", host: "ds.example.com" }]} />
          <GroupTile name={copy.folders[1]} meta={copy.bookmarks(4)} emptyLabel={copy.empty} onOpen={() => undefined}
            previews={["notes.example.org", "blog.example.dev", "news.example.kr", "maps.example.com"].map((host) => ({ kind: "site", host }))} />
        </Grid>
      );
    },
  },
  {
    name: "Phone: two columns",
    widths: ["375"],
    render: (context) => {
      const copy = COPY[context.locale];
      return (
        <Grid columns="2" gap="md">
          {[0, 2, 4].map((index) => <GroupTile key={index} name={copy.names[index]!} meta={copy.scraps(index ? 2 : 5)} emptyLabel={copy.empty}
            previews={previews(index === 4 ? 0 : index ? 2 : 5, context)} onOpen={() => undefined} />)}
          <GroupTileMore count={3} label={copy.moreGroups} meta={copy.viewAll} onOpen={() => undefined} />
        </Grid>
      );
    },
  },
];
