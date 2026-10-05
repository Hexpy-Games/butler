import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { PillButton } from "../../components/PillButton";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Box } from "../../components/Box";
import { ScrollArea } from "../ScrollArea";
import { AiChip, Plus, ShieldQuestion } from "../../components/Icons";
import { ComposerControl } from "../ComposerControl";
import { ContextDonutButton } from "../ContextDonutButton";
import { Notice } from "../Notice";
import {
  ComposerCard,
  ComposerCardEditable,
  ComposerCardEditor,
  ComposerCardPlaceholder,
  ComposerCardTextarea,
  ComposerCardInlineAction,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerPlanToggle,
  ComposerSendButton,
} from "./index";

export const meta: ShowcaseMeta = {
  title: "ComposerCard",
  category: "Composer",
  tags: ["composer", "glass", "chat", "input", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    placeholder: "Ask Butler anything", followUp: "Ask for follow-up changes", more: "More options", plan: "Plan",
    access: "Ask", model: "GPT-5.1", send: "Send", stop: "Stop", reconnecting: "Reconnecting to live updates",
    draft: "Summarize the motion tokens and list the components that still declare their own transitions.",
    preview: "Summarize the motion tokens…", optional: "Web search is off. Turn it on in Settings to cite sources.",
    context: "Context 42% used", noImages: "Model doesn't accept images",
  },
  "ko-KR": {
    placeholder: "Butler에게 무엇이든 물어보세요", followUp: "후속 변경사항 요청", more: "추가 기능", plan: "계획",
    access: "질문", model: "GPT-5.1", send: "전송", stop: "중지", reconnecting: "실시간 연결 복구 중",
    draft: "모션 토큰을 요약하고 아직 자체 전환을 선언하는 컴포넌트를 나열해 주세요.",
    preview: "모션 토큰을 요약하고…", optional: "웹 검색이 꺼져 있습니다. 출처를 인용하려면 설정에서 켜세요.",
    context: "컨텍스트 42% 사용", noImages: "이미지 미지원 모델",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** The product's split row and inline send, including loading/blocked states. */
function Composer({ context, large, mode = "send", busy, blocked }: {
  context: ShowcaseRenderContext; large?: boolean; mode?: "send" | "stop"; busy?: boolean; blocked?: boolean;
}) {
  const copy = text(context);
  const [draft, setDraft] = useState("");
  const controls = (
    <ScrollArea orientation="x" flush>
      <ButtonContainer size="sm" wrap={false} grow role="group" aria-label={copy.more}>
        <PillButton surface="glass" size="icon-lg" aria-label={copy.more}><Plus size="md" /></PillButton>
        <ComposerControl surface="glass" size="lg" compact="icon" icon={<ShieldQuestion size="sm" />} label={copy.access} />
        <Box grow aria-hidden="true" />
        <ContextDonutButton surface="glass" aria-label={copy.context} ratio={0.42} />
        <ComposerControl surface="glass" size="lg" icon={<AiChip size="sm" />} label={copy.model} detail="medium" />
      </ButtonContainer>
    </ScrollArea>
  );
  return (
    <ComposerCard large={large} controls={controls} onSubmit={(event) => event.preventDefault()}>
      <ComposerCardInlineAction action={
        <ComposerSendButton aria-label={busy ? copy.reconnecting : mode === "stop" ? copy.stop : copy.send} busy={busy}
          disabled={mode === "send" && !busy && !draft} disabledReason={blocked ? copy.noImages : undefined} mode={mode} />
      }>
        <ComposerCardEditor>
          <ComposerCardEditable>
            <div aria-label={copy.placeholder} contentEditable role="textbox" suppressContentEditableWarning
              onInput={(event) => setDraft(event.currentTarget.textContent ?? "")} />
          </ComposerCardEditable>
          {draft ? null : <ComposerCardPlaceholder>{large ? copy.placeholder : copy.followUp}</ComposerCardPlaceholder>}
        </ComposerCardEditor>
      </ComposerCardInlineAction>
    </ComposerCard>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Toolbar utilities", render: context => (
    <ComposerCard onSubmit={event => event.preventDefault()}>
      <ComposerCardTextarea aria-label={text(context).placeholder} rows={1} />
      <ComposerCardToolbar>
        <ComposerPlanToggle checked={false} label={text(context).plan} onCheckedChange={() => undefined} />
        <ComposerCardToolbarSpacer />
        <ComposerSendButton aria-label={text(context).send} />
      </ComposerCardToolbar>
    </ComposerCard>
  ) },
  { name: "New chat (large)", widths: ["375", "app", "wide"], render: (context) => <Composer context={context} large /> },
  { name: "Follow-up while a turn runs (stop)", states: ["busy"], render: (context) => <Composer context={context} mode="stop" /> },
  { name: "Reconnecting (busy send)", states: ["loading"], render: (context) => <Composer context={context} busy /> },
  // Inline send: an attached image the selected model refuses blocks send; the tooltip says why in a few words.
  { name: "Send blocked (text-only model)", states: ["disabled"], render: (context) => <Composer context={context} blocked /> },
  {
    name: "Drop target and notice",
    states: ["drop-active"],
    render: (context) => (
      <ComposerCard dropActive large notice={<Notice message={text(context).optional} tone="warning" />}
        onSubmit={(event) => event.preventDefault()}>
        <ComposerCardInlineAction action={<ComposerSendButton aria-label={text(context).send} />}>
          <ComposerCardTextarea aria-label={text(context).placeholder} defaultValue={text(context).draft} rows={1} />
        </ComposerCardInlineAction>
      </ComposerCard>
    ),
  },
];
