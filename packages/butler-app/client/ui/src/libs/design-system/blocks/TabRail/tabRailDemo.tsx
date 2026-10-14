import { useState, type ReactNode } from "react";
import type { AppLocale } from "../../../../../../../../butler-i18n/src/copy-contract.ts";
import { getAppCopy } from "../../../../../../../../butler-i18n/src/locale.ts";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Typo } from "../../components/Typo";
import { demoCard, type DemoState } from "../LiveTabCard/liveTabDemo";
import { ComposerCard } from "../ComposerCard";
import { ConversationScroll, ConversationShell, MessageListSurface } from "../ConversationShell";
import { MessageRow } from "../MessageRow";
import type { TabRailLabels, TabRailTab } from "./TabRail";
import { TabRail, type TabRailProps } from "./TabRail";
import styles from "./TabRail.showcase.module.css";

/** Labels as the App's AgentTabRail passes them (butler-i18n browser.*). */
export function railLabels(locale: AppLocale): TabRailLabels {
  const copy = getAppCopy(locale).browser;
  return { region: copy.rail.region, close: copy.closeTab, more: copy.rail.more };
}

/** Rail tabs in the owner's order; ids stay unique when a state repeats. */
export function railTabs(locale: AppLocale, states: readonly DemoState[]): TabRailTab[] {
  return states.map((state, index) => ({ id: `${state}-${index}`, ...demoCard(locale, state) }));
}

export const SET_A: readonly DemoState[] = ["handoff", "busy", "error", "idle", "approval"];
export const SET_B: readonly DemoState[] = ["approval", "held", "idle"];

/** A positioned stage the rail fills, like the conversation card. */
export function Stage({ height, children }: { height: "tall" | "short" | "strip"; children: ReactNode }) {
  return <div className={styles.stage} data-height={height}>{children}</div>;
}

export function Rail({ locale, states, ...props }: { locale: AppLocale; states: readonly DemoState[] } & Partial<TabRailProps>) {
  return <TabRail tabs={railTabs(locale, states)} labels={railLabels(locale)} onMore={() => undefined} {...props} />;
}

const chat = {
  "en-US": ["Find three campgrounds near the city for this weekend and compare them.", "I started browsing for candidates; I'll sum them up when done.", "Ask Butler anything"],
  "ko-KR": ["이번 주말에 갈 만한 서울 근교 캠핑장 세 곳만 찾아서 비교해줘", "브라우저로 후보를 찾아 비교하는 작업을 시작했습니다. 끝나면 정리해 드릴게요.", "버틀러에게 무엇이든 물어보세요"],
} as const;

/** The rail in a conversation: the mode follows the stage's width; the column moves only as far as needed. */
export function InConversation({ locale, states = SET_A }: { locale: AppLocale; states?: readonly DemoState[] }) {
  const [user, reply, prompt] = chat[locale];
  return (
    <div className={styles.conversation}>
      <ConversationShell composerReserve={72} railView="demo" rail={<Rail locale={locale} states={states} view="demo" />}>
        <ConversationScroll>
          <MessageListSurface>
            <MessageRow index={0} role="user"><Typo.Body as="p">{user}</Typo.Body></MessageRow>
            <MessageRow index={1} role="assistant"><Typo.Body as="p">{reply}</Typo.Body></MessageRow>
          </MessageListSurface>
        </ConversationScroll>
        <ComposerCard floating><Typo.Body as="p" tone="secondary">{prompt}</Typo.Body></ComposerCard>
      </ConversationShell>
    </div>
  );
}

const ORDER: readonly DemoState[] = ["busy", "idle", "error", "held"];

/** Tabs open and close: cards enter with a fade and a rise and leave faster (none under reduced motion). */
export function ComeAndGo({ locale, mode }: { locale: AppLocale; mode: "full" | "compact" | "shelf" }) {
  const [count, setCount] = useState(2);
  const words = locale === "ko-KR" ? { open: "탭 열기", close: "탭 닫기" } : { open: "Open a tab", close: "Close a tab" };
  return (
    <>
      <ButtonContainer size="sm">
        <Button size="sm" variant="secondary" disabled={count >= ORDER.length} onClick={() => setCount((value) => value + 1)}>{words.open}</Button>
        <Button size="sm" variant="secondary" disabled={count === 0} onClick={() => setCount((value) => value - 1)}>{words.close}</Button>
      </ButtonContainer>
      <Stage height={mode === "shelf" ? "strip" : "tall"}><Rail locale={locale} states={ORDER.slice(0, count)} mode={mode} view="come-and-go" /></Stage>
    </>
  );
}
