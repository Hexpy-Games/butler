import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { IconButton } from "../IconButton";
import { Trash2 } from "../Icons";
import { Separator } from "../Separator";
import { Stack } from "../Stack";
import { ExpandableText } from "./ExpandableText";

export const meta: ShowcaseMeta = {
  title: "ExpandableText",
  category: "Data display",
  tags: ["text", "clamp", "disclosure", "list"],
  status: "stable",
};

const labels = {
  "en-US": {
    long: "Answer in short paragraphs, put code in fenced blocks, and when a task touches files list each changed path at the end, so I can review the diff before anything is committed.",
    short: "Reply in English.",
    multi: "Weekly report format:\n1. What shipped\n2. What slipped and why\n3. Next week's three priorities",
    allChats: "All chats", thisChatOnly: "This chat only", expires: "All chats · Expires in 5 days", remove: "Delete",
  },
  "ko-KR": {
    long: "답변은 짧은 문단으로 나누고 코드는 코드 블록에 넣어 주세요. 파일을 고치는 작업이면 마지막에 바뀐 경로를 모두 적어 주세요. 커밋하기 전에 차이를 확인하고 싶습니다.",
    short: "한국어로 답해 주세요.",
    multi: "주간 보고 형식:\n1. 끝낸 일\n2. 밀린 일과 이유\n3. 다음 주 우선순위 세 가지",
    allChats: "모든 채팅", thisChatOnly: "이 채팅에서만", expires: "모든 채팅 · 5일 후 만료", remove: "삭제",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Row({ id, body, caption, removeLabel }: { id: string; body: string; caption: string; removeLabel: string }) {
  return (
    <Stack align="row" cross="start" gap="md">
      <Stack.Item grow minWidth="0"><ExpandableText id={id} meta={caption}>{body}</ExpandableText></Stack.Item>
      <IconButton label={removeLabel} aria-describedby={id}><Trash2 size="md" /></IconButton>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Instruction list rows",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <Stack gap="md">
        <Row id={`ds-et-long-${context.locale}`} body={text(context).long} caption={text(context).allChats} removeLabel={text(context).remove} />
        <Separator space="none" />
        <Row id={`ds-et-short-${context.locale}`} body={text(context).short} caption={text(context).thisChatOnly} removeLabel={text(context).remove} />
        <Separator space="none" />
        <Row id={`ds-et-multi-${context.locale}`} body={text(context).multi} caption={text(context).expires} removeLabel={text(context).remove} />
      </Stack>
    ),
  },
  {
    name: "Two collapsed lines",
    render: (context) => <ExpandableText collapsedLines={2}>{text(context).long}</ExpandableText>,
  },
  {
    name: "Fits: no toggle, empty chevron slot",
    render: (context) => <ExpandableText meta={text(context).allChats}>{text(context).short}</ExpandableText>,
  },
];
