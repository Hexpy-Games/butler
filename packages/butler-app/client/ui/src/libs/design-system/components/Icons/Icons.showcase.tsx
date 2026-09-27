import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { IconButton } from "../IconButton";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconGallery } from "./IconGallery";
import { Folder, LayoutDashboard, MessageSquare, Plus, Settings } from "./Icons";

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

export const stories: ShowcaseStory[] = [
  { name: "Full set", states: ["search", "copy"], widths: ["app", "wide"], render: () => <IconGallery /> },
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
