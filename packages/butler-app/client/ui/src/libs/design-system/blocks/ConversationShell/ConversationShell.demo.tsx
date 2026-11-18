import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { MessageRow } from "../MessageRow";
import { PromptSuggestionList } from "../PromptSuggestionList";
import { Wallpaper, type WallpaperContentRect, type WallpaperSource } from "../Wallpaper";
import { ConversationScroll, ConversationShell, MessageListSurface, type ConversationColumnRect } from "./ConversationShell";
import styles from "./ConversationShell.showcase.module.css";

/** A stable source (a module constant or memoized settings), as the product passes it. */
const BACKGROUND: WallpaperSource = { kind: "live", module: "butler.bloom", params: { colors: "aurora" } };
/** The showcase stage height (`.stage`): the column keep-out runs to the bottom. */
const STAGE_HEIGHT = 560;

const copy = {
  "en-US": {
    title: "Where should we start today?",
    suggestions: [["plan", "Plan today", "Order open work into steps."], ["review", "Review risky changes", "Find missed checks in recent work."]],
    reply: "Here is today's order: finish the review, then the release notes.",
  },
  "ko-KR": {
    title: "오늘은 어디서 시작할까요",
    suggestions: [["plan", "오늘 순서 세우기", "열린 일을 실행 순서로 정리합니다."], ["review", "위험한 변경 보기", "최근 작업에서 빠진 검증을 찾습니다."]],
    reply: "오늘 순서입니다. 리뷰를 마치고 릴리스 노트를 씁니다.",
  },
} as const;

const columnArea = (column: ConversationColumnRect): WallpaperContentRect => ({
  x: column.left, y: column.top, width: column.right - column.left, height: STAGE_HEIGHT,
});

/**
 * One wallpaper in the shell's `background` slot, shared by the new chat
 * (external-wallpaper mode reports its text) and the messages (the column
 * reports its edges): picking a suggestion swaps the content, never the
 * canvas.
 */
export function SharedBackground({ locale, startWithMessages = false }: ShowcaseRenderContext & { startWithMessages?: boolean }) {
  const text = copy[locale];
  const [sent, setSent] = useState<string | null>(startWithMessages ? text.suggestions[0][1] : null);
  const [promptRect, setPromptRect] = useState<WallpaperContentRect | undefined>(undefined);
  const [column, setColumn] = useState<ConversationColumnRect | undefined>(undefined);
  const contentRect = sent === null ? promptRect : column ? columnArea(column) : undefined;
  return (
    <div className={styles.stage}>
      <ConversationShell background={<Wallpaper contentRect={contentRect} scope="container" source={BACKGROUND} />} composerReserve={24}>
        {sent === null ? (
          <ConversationScroll masked={false} scrollable={false}>
            <PromptSuggestionList title={text.title} onContentRect={setPromptRect}
              suggestions={text.suggestions.map(([id, title, description]) => ({ id, title, description, text: title, onSelect: () => setSent(title) }))} />
          </ConversationScroll>
        ) : (
          <ConversationScroll>
            <MessageListSurface onColumnRect={setColumn}>
              <MessageRow index={0} role="user"><Typo.Text as="div" wrap="pre">{sent}</Typo.Text></MessageRow>
              <MessageRow index={1} role="assistant"><MarkdownContent><p>{text.reply}</p></MarkdownContent></MessageRow>
            </MessageListSurface>
          </ConversationScroll>
        )}
      </ConversationShell>
    </div>
  );
}
