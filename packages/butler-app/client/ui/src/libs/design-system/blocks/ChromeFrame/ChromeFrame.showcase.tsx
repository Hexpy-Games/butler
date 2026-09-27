import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Folder, MessageSquare, PencilLine, Search } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { KeyValueRow } from "../KeyValueRow";
import { MessageRow } from "../MessageRow";
import { NavRow } from "../NavRow";
import { ChromeFrame } from "./ChromeFrame";

export const meta: ShowcaseMeta = {
  title: "ChromeFrame",
  category: "Shell",
  tags: ["chrome", "shell", "layout", "responsive"],
  status: "stable",
};

const copy = {
  "en-US": {
    title: "Settings hierarchy", newChat: "New chat", search: "Search", project: "Desktop client polish", other: "Release notes draft",
    user: "Can you tighten the settings section headers?",
    assistant: "Each section header is now its own block, closed by a hairline before the first field.",
    context: "Context", files: "Files", model: "Model", healthy: "healthy",
  },
  "ko-KR": {
    title: "설정 화면 위계", newChat: "새 대화", search: "검색", project: "데스크톱 앱 다듬기", other: "릴리스 노트 초안",
    user: "설정 섹션 머리를 좀 더 정리해 줄래?",
    assistant: "이제 각 섹션 머리는 하나의 블록이고, 첫 필드 앞에서 가는 구분선으로 끝납니다.",
    context: "컨텍스트", files: "파일", model: "모델", healthy: "양호",
  },
} as const;

function Frame({ locale, rightOpen, leftCollapsed }: ShowcaseRenderContext & { rightOpen: boolean; leftCollapsed: boolean }) {
  const text = copy[locale];
  return (
    <ChromeFrame
      rightOpen={rightOpen}
      leftCollapsed={leftCollapsed}
      titlebar={<Stack align="row" gap="sm" cross="center"><Typo.AppTitle>{text.title}</Typo.AppTitle></Stack>}
      sidebar={
        <Stack gap="xs">
          <NavRow icon={<PencilLine />} label={text.newChat} />
          <NavRow icon={<Search />} label={text.search} />
          <NavRow icon={<Folder />} label={text.project} active />
          <NavRow icon={<MessageSquare />} label={text.other} />
        </Stack>
      }
      inspector={
        <Stack gap="xs">
          <KeyValueRow label={text.context} value="64%" meta={text.healthy} />
          <KeyValueRow label={text.files} value="12" />
          <KeyValueRow label={text.model} value="GPT-5.5" />
        </Stack>
      }
    >
      <Stack gap="md">
        <MessageRow role="user"><Typo.Body as="p">{text.user}</Typo.Body></MessageRow>
        <MessageRow role="assistant"><Typo.Body as="p">{text.assistant}</Typo.Body></MessageRow>
      </Stack>
    </ChromeFrame>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Sidebar and main", render: (context) => <Frame {...context} rightOpen={false} leftCollapsed={false} /> },
  { name: "Sidebar, main and inspector", widths: ["wide"], render: (context) => <Frame {...context} rightOpen leftCollapsed={false} /> },
  { name: "Sidebar collapsed", states: ["collapsed"], render: (context) => <Frame {...context} rightOpen={false} leftCollapsed /> },
];
