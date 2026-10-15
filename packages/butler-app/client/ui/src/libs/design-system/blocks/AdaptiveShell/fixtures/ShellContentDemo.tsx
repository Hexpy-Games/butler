import { IconButton } from "../../../components/IconButton";
import { Clock3, FileText, ListFilter, Plus, Sparkles } from "../../../components/Icons";
import { DemoChat } from "../../BrowserPane/fixtures/ConversationFrame";
import { ComposerCard, ComposerCardExpandedBody, ComposerCardTextarea, ComposerCardToolbar } from "../../ComposerCard";
import { ConversationScroll, ConversationShell } from "../../ConversationShell";
import { InspectorPanel } from "../../InspectorPanel";
import { InspectorShell } from "../../InspectorShell";
import { ListRow } from "../../ListRow";
import { PromptSuggestionList } from "../../PromptSuggestionList";

type Locale = "en-US" | "ko-KR";

/** What fills the content card: the short demo exchange, a long conversation, or the empty new-chat state. */
export type ShellContent = "chat" | "long" | "empty";

const COPY = {
  "en-US": {
    summary: "Summary", artifacts: "Artifacts", schedules: "Schedules", progress: "Progress",
    step: "Find and order the chair", weekly: "Weekly summary", composer: "Ask Butler anything", more: "More options",
    title: "What should we open today?", description: "A few simple starting points are ready.", moment: "5:23 PM",
    suggestions: [
      ["cleanup", "Downloads folder cleanup", "Butler checks files on this computer and asks before moving them."],
      ["summary", "Document summary", "Attach or paste a document to get the key points."],
      ["reply", "Reply draft", "Turn a short note into a clear reply."],
      ["briefing", "Morning briefing", "Create a daily 8 AM schedule for weather, news, and today's plans."],
    ],
  },
  "ko-KR": {
    summary: "요약", artifacts: "아티팩트", schedules: "예약 작업", progress: "진행 상황",
    step: "의자 찾아 주문하기", weekly: "주간 요약", composer: "버틀러에게 무엇이든 물어보세요", more: "더 보기",
    title: "오늘은 무엇을 열어볼까요?", description: "간단한 시작점을 준비해 두었어요.", moment: "오후 5:23",
    suggestions: [
      ["cleanup", "다운로드 폴더 정리", "이 컴퓨터의 파일을 살펴보고, 옮기기 전에 먼저 물어봅니다."],
      ["summary", "문서 요약", "문서를 첨부하거나 붙여 넣으면 핵심만 추려 드려요."],
      ["reply", "답장 초안", "짧은 메모를 깔끔한 답장으로 다듬어 드려요."],
      ["briefing", "아침 브리핑", "날씨, 뉴스, 오늘 일정을 매일 오전 8시에 알려 주는 예약 작업을 만들어요."],
    ],
  },
} as const;

/** The inspector card; `tall` fills it with more rows than fit, so it scrolls inside its own bounds. */
export function DemoInspector({ locale, tall = false }: { locale: Locale; tall?: boolean }) {
  const copy = COPY[locale];
  const rows = tall ? 40 : 1;
  return (
    <InspectorShell activeTab="summary" onTabChange={() => undefined} tabs={[
      { id: "summary", label: copy.summary, icon: <ListFilter size="md" /> },
      { id: "artifacts", label: copy.artifacts, icon: <FileText size="md" /> },
      { id: "schedules", label: copy.schedules, icon: <Clock3 size="md" /> },
    ]}>
      <InspectorPanel title={copy.progress}>
        {Array.from({ length: rows }, (_, index) => (
          <ListRow key={index} icon={<ListFilter size="md" />} title={copy.step} />
        ))}
        <ListRow icon={<FileText size="md" />} title={copy.weekly} />
      </InspectorPanel>
    </InspectorShell>
  );
}

function DemoComposer({ locale }: { locale: Locale }) {
  const copy = COPY[locale];
  return (
    <ComposerCard large onSubmit={(event) => event.preventDefault()}>
      <ComposerCardExpandedBody>
        <ComposerCardTextarea aria-label={copy.composer} placeholder={copy.composer} rows={1} />
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>
      </ComposerCardToolbar>
    </ComposerCard>
  );
}

/** The content card's body as the App composes it: a conversation shell with its own scroll and a docked composer. */
export function DemoConversation({ locale, content, wallpaper }: { locale: Locale; content: ShellContent; wallpaper: boolean }) {
  if (content === "chat") return <DemoChat locale={locale} wallpaper={wallpaper} />;
  const copy = COPY[locale];
  return (
    <ConversationShell composerReserve={160}>
      <ConversationScroll>
        {content === "long" ? Array.from({ length: 12 }, (_, index) => <DemoChat key={index} locale={locale} />) : (
          <PromptSuggestionList title={copy.title} description={copy.description} moment={copy.moment} titleIcon={<Sparkles />}
            suggestions={copy.suggestions.map(([id, title, description]) => ({ id, title, description, text: title }))} />
        )}
      </ConversationScroll>
      {/* Viewer stand-in for the App's composer dock: pinned to the conversation's bottom edge. */}
      <div style={{ position: "absolute", insetInline: "var(--space-lg)", bottom: "var(--space-lg)" }}>
        <DemoComposer locale={locale} />
      </div>
    </ConversationShell>
  );
}
