import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { AiChip, Plus, ShieldQuestion } from "../../components/Icons";
import { ComposerControl } from "../ComposerControl";
import { ContextDonutButton } from "../ContextDonutButton";
import { Notice } from "../Notice";
import {
  COMPOSER_EDGE_CHARACTER_RISE,
  ComposerCard,
  ComposerCardCompactPreview,
  ComposerCardEditable,
  ComposerCardEditor,
  ComposerCardExpandedBody,
  ComposerCardExpandedControls,
  ComposerCardPlaceholder,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerDecoration,
  ComposerEdgeCharacter,
  type ComposerDecorationScene,
  type ComposerEdgeCharacterKind,
  ComposerPlanToggle,
  ComposerSendButton,
} from "./index";
import styles from "./ComposerCard.showcase.module.css";

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
    placeholder: "버틀러에게 무엇이든 물어보세요", followUp: "후속 변경사항 요청", more: "추가 기능", plan: "계획",
    access: "질문", model: "GPT-5.1", send: "전송", stop: "중지", reconnecting: "실시간 연결 복구 중",
    draft: "모션 토큰을 요약하고 아직 자체 전환을 선언하는 컴포넌트를 나열해 주세요.",
    preview: "모션 토큰을 요약하고…", optional: "웹 검색이 꺼져 있습니다. 출처를 인용하려면 설정에서 켜세요.",
    context: "컨텍스트 42% 사용", noImages: "이미지 미지원 모델",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

// The shoreline scene with its crab on the top edge (composerDecorationEdge("shoreline") returns the same parts).
const SCENES = {
  shoreline: { decoration: <ComposerDecoration scene="shoreline" />, character: "crab" },
  cherry: { decoration: <ComposerDecoration scene="cherry" />, character: "cat" },
} satisfies Record<ComposerDecorationScene, { decoration: ReactNode; character: ComposerEdgeCharacterKind }>;
const edgeOf = (kind: ComposerEdgeCharacterKind) => ({
  behind: <ComposerEdgeCharacter kind={kind} part="behind" />, front: <ComposerEdgeCharacter kind={kind} part="front" />, reserveTop: COMPOSER_EDGE_CHARACTER_RISE,
});

/** The product composer: editor, toolbar controls, context donut and send. */
function Composer({ context, large, mode = "send", busy, blocked, scene }: {
  context: ShowcaseRenderContext; large?: boolean; mode?: "send" | "stop"; busy?: boolean; blocked?: boolean; scene?: ComposerDecorationScene;
}) {
  const copy = text(context);
  const [plan, setPlan] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <ComposerCard decoration={scene ? SCENES[scene].decoration : undefined} edge={scene ? edgeOf(SCENES[scene].character) : undefined} large={large}
      onSubmit={(event) => event.preventDefault()}>
      <ComposerCardExpandedBody>
        <ComposerCardEditor>
          <ComposerCardEditable>
            <div aria-label={copy.placeholder} contentEditable role="textbox" suppressContentEditableWarning
              onInput={(event) => setDraft(event.currentTarget.textContent ?? "")} />
          </ComposerCardEditable>
          {draft ? null : <ComposerCardPlaceholder>{large ? copy.placeholder : copy.followUp}</ComposerCardPlaceholder>}
        </ComposerCardEditor>
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>
        <ComposerCardExpandedControls>
          <ComposerControl compact="label" icon={<ShieldQuestion size="sm" />} label={copy.access} />
          <ComposerPlanToggle checked={plan} label={copy.plan} onCheckedChange={setPlan} />
          <ComposerCardToolbarSpacer />
          <ContextDonutButton aria-label={copy.context} ratio={0.42} />
          <ComposerControl icon={<AiChip size="sm" />} label={copy.model} detail="medium" />
        </ComposerCardExpandedControls>
        <ComposerSendButton aria-label={busy ? copy.reconnecting : mode === "stop" ? copy.stop : copy.send} busy={busy}
          disabled={mode === "send" && !busy && !draft} disabledReason={blocked ? copy.noImages : undefined} mode={mode} />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}

/** The decorated new-chat composer in both themes. */
function DecoratedComposers({ context, scene }: { context: ShowcaseRenderContext; scene: ComposerDecorationScene }) {
  return (
    <div className={styles.tones}>
      {(["light", "dark"] as const).map((tone) => (
        <div className={`${styles.tone} theme-${tone}`} key={tone}><Composer context={context} large scene={scene} /></div>
      ))}
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "New chat (large)", widths: ["375", "app", "wide"], render: (context) => <Composer context={context} large /> },
  { name: "New chat with the shoreline decoration", widths: ["375", "app", "wide"], render: (context) => <DecoratedComposers context={context} scene="shoreline" /> },
  { name: "New chat with the cherry decoration", widths: ["375", "app", "wide"], render: (context) => <DecoratedComposers context={context} scene="cherry" /> },
  { name: "Follow-up while a turn runs (stop)", states: ["busy"], render: (context) => <Composer context={context} mode="stop" /> },
  { name: "Reconnecting (busy send)", states: ["loading"], render: (context) => <Composer context={context} busy /> },
  // ComposerToolbar: an attached image the selected model refuses blocks send; the tooltip says why in a few words.
  { name: "Send blocked (text-only model)", states: ["disabled"], render: (context) => <Composer context={context} blocked /> },
  {
    name: "Folded preview, drop target and notice",
    states: ["drop-active", "collapsed"],
    render: (context) => (
      <ComposerCard dropActive expanded={false} large notice={<Notice message={text(context).optional} tone="warning" />}
        onSubmit={(event) => event.preventDefault()}>
        <ComposerCardExpandedBody>
          <ComposerCardTextarea aria-label={text(context).placeholder} defaultValue={text(context).draft} rows={1} />
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <IconButton label={text(context).more}><Plus size="md" /></IconButton>
          <ComposerCardCompactPreview>{text(context).preview}</ComposerCardCompactPreview>
          <ComposerSendButton aria-label={text(context).send} />
        </ComposerCardToolbar>
      </ComposerCard>
    ),
  },
];
