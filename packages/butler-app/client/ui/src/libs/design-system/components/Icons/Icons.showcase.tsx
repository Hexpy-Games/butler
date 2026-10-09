import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { IconButton } from "../IconButton";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconGallery } from "./IconGallery";
import {
  ArrowRight, Bookmark, Download, Folder, Key, LayoutDashboard, Library, MessageSquare, Pick, Plus, Popup, Scrap, Settings,
  Star, StarFilled, TabIn, Warning, type IconProps,
} from "./Icons";
import type { ComponentType } from "react";

export const meta: ShowcaseMeta = {
  title: "Icons",
  category: "Data display",
  tags: ["iconography", "hugeicons", "glyph", "size"],
  status: "stable",
};

const labels = {
  "en-US": { dashboard: "Dashboard", newChat: "New chat", settings: "Settings", caption: "Icons inherit currentColor and take a token size." },
  "ko-KR": { dashboard: "대시보드", newChat: "새 대화", settings: "설정", caption: "아이콘은 currentColor를 따르고 토큰 크기를 받습니다." },
} as const;

/** The browser set (toolbar, page band, library), each with its name and what it stands for. */
const BROWSER_ICONS: Array<[string, ComponentType<IconProps>, string, string]> = [
  ["Pick", Pick, "Pick elements", "요소 선택"], ["Scrap", Scrap, "Scrap", "스크랩"],
  ["Bookmark", Bookmark, "Bookmarks", "북마크"], ["Star", Star, "Add bookmark", "북마크 추가"],
  ["StarFilled", StarFilled, "Bookmarked", "북마크됨"], ["Download", Download, "Downloads", "다운로드"],
  ["Popup", Popup, "Pop-up", "팝업"], ["Key", Key, "Your input needed", "직접 입력 필요"],
  ["ArrowRight", ArrowRight, "Forward", "앞으로"], ["Warning", Warning, "Not secure", "주의 요함"],
  ["Library", Library, "Library", "서랍"], ["TabIn", TabIn, "Bring in a tab", "내 탭 가져오기"],
];

function BrowserIconSet({ locale }: { locale: "en-US" | "ko-KR" }) {
  return (
    <Stack gap="sm">
      {BROWSER_ICONS.map(([name, Glyph, en, ko]) => (
        <Stack key={name} align="row" gap="md" cross="center">
          <Glyph size="sm" />
          <Glyph size="md" />
          <Typo.Code>{name}</Typo.Code>
          <Typo.Caption tone="secondary">{locale === "ko-KR" ? ko : en}</Typo.Caption>
        </Stack>
      ))}
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Full set", states: ["search", "copy"], widths: ["app", "wide"], render: () => <IconGallery /> },
  { name: "Browser set (sm, md)", render: ({ locale }) => <BrowserIconSet locale={locale} /> },
  {
    name: "In controls",
    render: ({ locale }) => (
      <Stack gap="sm">
        <Stack align="row" gap="sm" cross="center">
          <Folder size="sm" /><MessageSquare size="md" /><Plus size="lg" />
        </Stack>
        <Stack align="row" gap="xs">
          <IconButton label={labels[locale].dashboard}><LayoutDashboard size="md" /></IconButton>
          <IconButton label={labels[locale].newChat}><Plus size="md" /></IconButton>
          <IconButton label={labels[locale].settings}><Settings size="md" /></IconButton>
        </Stack>
        <Typo.Caption>{labels[locale].caption}</Typo.Caption>
      </Stack>
    ),
  },
];
