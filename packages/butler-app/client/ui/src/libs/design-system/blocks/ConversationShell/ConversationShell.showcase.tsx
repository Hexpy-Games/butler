import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { MessageRow } from "../MessageRow";
import {
  ConversationScroll,
  ConversationScrollToBottomButton,
  ConversationShell,
  MessageListSurface,
} from "./ConversationShell";
import { SharedBackground } from "./ConversationShell.demo";
import { AsideBesideBrowser, DockedAside, DockedAsideToggle, FloatingAside } from "./ConversationShell.asideDemo";
import { InConversation } from "../TabRail/tabRailDemo";
import styles from "./ConversationShell.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "ConversationShell",
  category: "Conversation & Activity",
  tags: ["conversation", "chat", "scroll", "layout"],
  status: "stable",
};

const copy = {
  "en-US": {
    turns: [
      ["user", "Can you check why the settings page feels flat?"],
      ["assistant", "The section description is the same size as the field labels and sits as close to the first field as fields sit to each other, so the page reads as one long list."],
      ["user", "What would you change first?"],
      ["assistant", "Give each section header its own block: a 13px secondary description with a limited measure, closed by a hairline before the first field."],
      ["user", "Do it, and keep the field spacing as it is."],
      ["assistant", "Done. The header block now ends with a divider and the type ramp reads title, label, description."],
    ],
    latest: "Jump to latest", unread: "New messages",
  },
  "ko-KR": {
    turns: [
      ["user", "설정 화면이 왜 밋밋해 보이는지 봐 줄래?"],
      ["assistant", "섹션 설명이 필드 이름과 같은 크기이고 첫 필드와의 간격도 필드 사이 간격과 같아서, 페이지 전체가 긴 목록처럼 읽힙니다."],
      ["user", "먼저 무엇을 바꾸면 좋을까?"],
      ["assistant", "섹션 머리를 하나의 블록으로 만들겠습니다. 설명은 13px 보조 색으로 줄 길이를 제한하고, 첫 필드 앞에 가는 구분선을 둡니다."],
      ["user", "그렇게 해 줘. 필드 간격은 그대로 두고."],
      ["assistant", "적용했습니다. 이제 섹션 머리는 구분선으로 끝나고, 글자 위계는 제목, 이름, 설명 순으로 읽힙니다."],
    ],
    latest: "최신으로 이동", unread: "새 메시지",
  },
} as const;

function Conversation({ locale, jump }: ShowcaseRenderContext & { jump: boolean }) {
  const text = copy[locale];
  return (
    <div className={styles.frame}>
      <ConversationShell composerReserve={24}>
        <ConversationScroll>
          <MessageListSurface>
            {text.turns.map(([role, body], index) => (
              <MessageRow key={index} role={role as "user" | "assistant"} index={index}>
                {/* As the App renders them: user text as typed, assistant text as Markdown. */}
                {role === "user" ? <Typo.Text as="div" wrap="pre">{body}</Typo.Text> : <MarkdownContent><p>{body}</p></MarkdownContent>}
              </MessageRow>
            ))}
          </MessageListSurface>
        </ConversationScroll>
        {jump ? (
          <ConversationScrollToBottomButton ariaLabel={text.latest} hasUnreadMessages onScrollToBottom={() => undefined}>
            {text.unread}
          </ConversationScrollToBottomButton>
        ) : null}
      </ConversationShell>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Messages", states: ["scroll"], render: (context) => <Conversation {...context} jump={false} /> },
  { name: "Unread below", states: ["unread"], render: (context) => <Conversation {...context} jump /> },
  { name: "Background: new chat, then messages", widths: ["app", "wide", "375"], render: (context) => <SharedBackground {...context} /> },
  { name: "Background behind messages", widths: ["app", "wide", "375"], render: (context) => <SharedBackground {...context} startWithMessages /> },
  // rail: a TabRail; the column and composer move left only as far as needed (full, compact), or start below a shelf.
  { name: "Tab rail beside the messages", widths: ["320", "375", "app", "wide"], render: ({ locale }) => <InConversation locale={locale} /> },
  // aside: docked flat in the margin from a 960px shell (Wide), one Card per section (margin variant B).
  { name: "Aside docked: margin cards", widths: ["app", "wide"], render: (context) => <DockedAside {...context} /> },
  // Open/close: the column glides on a transform and the aside rides in or out with it (--motion-slow, emphasized).
  // Reduced motion (the viewer's motion=reduced): both move at once, no fade, same end state.
  { name: "Aside docked: open and close", states: ["open"], widths: ["app", "wide"], render: (context) => <DockedAsideToggle {...context} /> },
  { name: "Aside floating", states: ["open"], widths: ["375", "app", "wide"], render: (context) => <FloatingAside {...context} /> },
  { name: "Aside floating beside the browser pane", widths: ["app", "wide"], render: (context) => <AsideBesideBrowser {...context} /> },
];
