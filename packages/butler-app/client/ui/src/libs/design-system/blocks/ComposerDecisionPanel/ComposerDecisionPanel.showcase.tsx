import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { ChevronDown, ListChecks, ShieldCheck } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { SplitButton } from "../SplitButton";
import { ComposerDecisionPanel } from "./ComposerDecisionPanel";

export const meta: ShowcaseMeta = {
  title: "ComposerDecisionPanel",
  category: "Composer",
  tags: ["composer", "decision", "approval", "plan", "authority"],
  status: "stable",
};

const labels = {
  "en-US": {
    plan: "Design system final cleanup plan: remove product CSS modules and verify pixel equivalence end to end",
    instruction: "Add instruction", reject: "Keep planning", accept: "Accept plan",
    authority: "Allow writing files outside the workspace", later: "Compose a message first",
    deny: "Deny", once: "Allow once", scope: "Allow scope", conversation: "Allow for this conversation",
    error: "Could not send the decision. Try again.",
  },
  "ko-KR": {
    plan: "디자인 시스템 최종 정리 계획: 제품 CSS 모듈 제거와 픽셀 동등성 검증까지 한 번에 진행",
    instruction: "지시 추가", reject: "계속 계획", accept: "계획 승인",
    authority: "워크스페이스 밖의 파일 쓰기 허용 요청", later: "먼저 메시지 작성",
    deny: "거절", once: "한 번 허용", scope: "허용 범위", conversation: "이 대화에서 허용",
    error: "결정을 보내지 못했습니다. 다시 시도하세요.",
  },
} as const;

function Plan({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel icon={<ListChecks aria-hidden="true" size="lg" />} title={copy.plan} onOpen={() => undefined}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="outline">{copy.instruction}</Button>
        <Button size="sm" variant="secondary">{copy.reject}</Button>
        <Button size="sm">{copy.accept}</Button>
      </ButtonContainer>} />
  );
}

function Authority({ context, error }: { context: ShowcaseRenderContext; error?: boolean }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel icon={<ShieldCheck aria-hidden="true" size="lg" />} title={copy.authority} onOpen={() => undefined}
      error={error ? copy.error : undefined}
      aside={<>
        <Typo.Caption>+2</Typo.Caption>
        <Button size="sm" variant="borderless" aria-label={copy.later} title={copy.later}><ChevronDown aria-hidden="true" size="md" /></Button>
      </>}
      actions={<ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary">{copy.deny}</Button>
        <SplitButton size="sm" text={copy.once} onClick={() => undefined} menuLabel={copy.scope} menuSide="top"
          items={[{ key: "conversation", label: copy.conversation, onSelect: () => undefined }]} />
      </ButtonContainer>} />
  );
}

export const stories: ShowcaseStory[] = [
  // ComposerPlanDecisionSurface: a plan waiting for acceptance.
  { name: "Plan decision", widths: ["375", "app"], render: (context) => <Plan context={context} /> },
  // ComposerAuthorityDecisionSurface: a pending count and compose-later aside, SplitButton scope.
  { name: "Authority decision", widths: ["375", "app"], render: (context) => <Authority context={context} /> },
  { name: "Failed decision", render: (context) => <Authority context={context} error /> },
];
