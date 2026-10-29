import { useState, type ReactNode } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Card } from "../../components/Card";
import { Bot, FileText, Flag, Folder, ImageIcon, ListChecks, MessageSquare, ShieldCheck, ShieldQuestion, Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { BrowserDemo } from "../BrowserPane/fixtures/BrowserDemo";
import { ScaledFrame } from "../BrowserPane/fixtures/ScaledFrame";
import { ComposerCard } from "../ComposerCard";
import { MarkdownContent } from "../MarkdownContent";
import { MessageRow } from "../MessageRow";
import { NavRow } from "../NavRow";
import { NavSection } from "../NavSection";
import { ProgressMeter } from "../ProgressMeter";
import { ConversationScroll, ConversationShell, MessageListSurface, type AsideLayout } from "./ConversationShell";
import styles from "./ConversationShell.showcase.module.css";

type Row = readonly [icon: ReactNode, label: string, meta: string];

const copy = {
  "en-US": {
    label: "Session details", prompt: "Ask about this task",
    chat: [["user", "Draft the preview 14 release notes too."], ["assistant", "The draft is in docs/release/preview-14.md. Commit it when you have read it."]],
    asks: ["Waiting for you", [[<ShieldQuestion size="sm" />, "Commit the release notes draft", "Approval · 2 min ago"],
      [<MessageSquare size="sm" />, "Include it in the release notes?", "Question · answer later"],
      [<Flag size="sm" />, "Shortcut input conflict", "Task draft · 8 min ago"]]],
    task: ["Task", "Session details area", "In progress · Running · Preview 14", "Work", "3 of 5 done", "Connect the requests API", "Running"],
    results: ["Results", ["preview-14.md", "ime-guard.patch"]], files: ["Attachments", ["shortcut-conflict.png"]],
    env: ["Environment", [["Butler app", "Local"], ["gpt-6-luna", "Medium"], ["Ask first", ""]]],
  },
  "ko-KR": {
    label: "세션 정보", prompt: "이 과제에 대해 말해 보세요",
    chat: [["user", "릴리스 노트 초안도 만들어줘."], ["assistant", "프리뷰 14 릴리스 노트 초안을 docs/release/preview-14.md에 만들었습니다. 읽어 보시고 커밋해 주세요."]],
    asks: ["답을 기다리는 요청", [[<ShieldQuestion size="sm" />, "릴리스 노트 초안 커밋", "승인 · 2분 전"],
      [<MessageSquare size="sm" />, "릴리스 노트에 넣을지", "질문 · 나중에 답하기로 함"],
      [<Flag size="sm" />, "단축키 입력창 충돌", "과제 초안 · 8분 전"]]],
    task: ["과제", "세션 정보 영역", "진행 중 · 실행 · 프리뷰 14", "작업", "3/5 완료", "요청 목록 API 연결", "진행 중"],
    results: ["결과물", ["preview-14.md", "ime-guard.patch"]], files: ["첨부", ["단축키-충돌.png"]],
    env: ["환경", [["버틀러 앱", "로컬"], ["gpt-6-luna", "보통"], ["먼저 확인", ""]]],
  },
} as const;

const Meta = ({ children }: { children: string }) => <Typo.Caption tone="secondary" truncate>{children}</Typo.Caption>;
const Count = ({ n }: { n: number }) => <Typo.Caption tone="tertiary" numeric="tabular">{n}</Typo.Caption>;
const ENV_ICONS = [<Folder size="sm" />, <Sparkles size="sm" />, <ShieldCheck size="sm" />];

/** The session-details sections, as the App composes them from NavSection and NavRow. */
function sections(locale: ShowcaseRenderContext["locale"]): Array<[string, ReactNode]> {
  const text = copy[locale];
  const [asksTitle, asks] = text.asks;
  const [taskTitle, title, state, work, done, action, running] = text.task;
  return [
    ["asks", <NavSection title={asksTitle} actions={<Count n={asks.length} />}>
      {asks.map(([icon, label, meta]: Row) => <NavRow key={label} icon={icon} label={label} multiline meta={<Meta>{meta}</Meta>} onClick={() => undefined} />)}
    </NavSection>],
    ["task", <NavSection title={taskTitle}>
      <NavRow icon={<ListChecks size="sm" />} label={title} multiline meta={<Meta>{state}</Meta>} onClick={() => undefined} />
      <Box paddingX="sm" paddingY="xs"><ProgressMeter label={work} meta={done} value={60} /></Box>
      <NavRow icon={<Bot size="sm" />} label={action} badge={<Meta>{running}</Meta>} />
    </NavSection>],
    ["results", <NavSection title={text.results[0]} actions={<Count n={text.results[1].length} />}>
      {text.results[1].map((name) => <NavRow key={name} icon={<FileText size="sm" />} label={name} onClick={() => undefined} />)}
    </NavSection>],
    ["files", <NavSection title={text.files[0]} actions={<Count n={text.files[1].length} />}>
      {text.files[1].map((name) => <NavRow key={name} icon={<ImageIcon size="sm" />} label={name} onClick={() => undefined} />)}
    </NavSection>],
    ["env", <NavSection title={text.env[0]}>
      {text.env[1].map(([label, badge], index) => <NavRow key={label} icon={ENV_ICONS[index]} label={label} badge={badge ? <Meta>{badge}</Meta> : undefined} />)}
    </NavSection>],
  ];
}

/**
 * Margin variant B: docked, one flat Card per section, 12px apart; floating, the glass is the only
 * surface, so the sections sit bare on it (cards inside glass would stack two surfaces).
 */
export function SessionDetails({ locale, layout }: ShowcaseRenderContext & { layout: AsideLayout }) {
  const parts = sections(locale);
  return layout === "docked"
    ? <Stack gap="md">{parts.map(([key, section]) => <Card key={key} padding="sm">{section}</Card>)}</Stack>
    : <Stack gap="xl">{parts.map(([key, section]) => <Box key={key}>{section}</Box>)}</Stack>;
}

/** A conversation with the session details in its aside; the stage's width decides docked or floating. */
export function AsideConversation({ locale, floatOpen = true, open = true }: ShowcaseRenderContext & { floatOpen?: boolean; open?: boolean }) {
  const text = copy[locale];
  return (
    <ConversationShell composerReserve={72} asideFloatOpen={floatOpen} asideLabel={text.label}
      aside={open ? (layout) => <SessionDetails locale={locale} layout={layout} /> : undefined}>
      <ConversationScroll>
        <MessageListSurface>
          {text.chat.map(([role, body], index) => (
            <MessageRow key={role} index={index} role={role}>
              {role === "user" ? <Typo.Text as="div" wrap="pre">{body}</Typo.Text> : <MarkdownContent><p>{body}</p></MarkdownContent>}
            </MessageRow>
          ))}
        </MessageListSurface>
      </ConversationScroll>
      <ComposerCard floating><Typo.Body as="p" tone="secondary">{text.prompt}</Typo.Body></ComposerCard>
    </ConversationShell>
  );
}

/** Docked: a 1100px chat card laid out at full size and scaled to the story width, so it docks at every viewer width. */
export function DockedAside(context: ShowcaseRenderContext) {
  return <ScaledFrame width={1100} height={620}><div className={styles.asideStage}><AsideConversation {...context} /></div></ScaledFrame>;
}

/** Docked, opened and closed by the title-bar toggle: the column glides left as the aside rides in, and back. */
export function DockedAsideToggle(context: ShowcaseRenderContext) {
  const [open, setOpen] = useState(true);
  return (
    <Stack gap="sm">
      <ButtonContainer size="sm">
        <Button size="sm" variant="secondary" aria-pressed={open} onClick={() => setOpen((value) => !value)}>{copy[context.locale].label}</Button>
      </ButtonContainer>
      <ScaledFrame width={1100} height={620}><div className={styles.asideStage}><AsideConversation {...context} open={open} /></div></ScaledFrame>
    </Stack>
  );
}

/** Floating: the title-bar toggle opens and closes the glass panel (DS fade). */
export function FloatingAside(context: ShowcaseRenderContext) {
  const [open, setOpen] = useState(true);
  return (
    <Stack gap="sm">
      <ButtonContainer size="sm">
        <Button size="sm" variant="secondary" aria-pressed={open} onClick={() => setOpen((value) => !value)}>{copy[context.locale].label}</Button>
      </ButtonContainer>
      <div className={styles.asideStage} data-width="narrow"><AsideConversation {...context} floatOpen={open} /></div>
    </Stack>
  );
}

/** Beside an open browser pane (a 1180px window) the chat card is narrow, so the aside floats over it. */
export function AsideBesideBrowser({ locale }: ShowcaseRenderContext) {
  return (
    <ScaledFrame width={1180} height={620}>
      <div className={styles.besideBrowser}>
        <div className={styles.chatCard}><AsideConversation locale={locale} /></div>
        <BrowserDemo locale={locale} placement="conversation" />
      </div>
    </ScaledFrame>
  );
}
