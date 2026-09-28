import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { ChevronDown, Folder, ListChecks, ShieldCheck, Terminal } from "../../components/Icons";
import { Tag } from "../../components/Tag";
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
    deny: "Deny", once: "Allow once", scope: "Allow scope", conversation: "Always allow in this conversation",
    error: "Could not send the decision. Try again.",
    rename: "Edit 24 files in your Desktop folder?", more: "+21 more", medium: "Medium risk",
    command: "Run a command in garden?", high: "High risk",
  },
  "ko-KR": {
    plan: "디자인 시스템 최종 정리 계획: 제품 CSS 모듈 제거와 픽셀 동등성 검증까지 한 번에 진행",
    instruction: "지시 추가", reject: "계속 계획", accept: "계획 승인",
    authority: "워크스페이스 밖의 파일 쓰기 허용 요청", later: "먼저 메시지 작성",
    deny: "거절", once: "이번만 허용", scope: "허용 범위", conversation: "이 대화에서 계속 허용",
    error: "결정을 보내지 못했습니다. 다시 시도하세요.",
    rename: "데스크톱의 파일 24개를 수정할까요?", more: "외 21개", medium: "위험 보통",
    command: "garden에서 명령을 실행할까요?", high: "위험 높음",
  },
} as const;

const screenshots = ["Screenshot 2026-09-27 at 10.02.14.png", "Screenshot 2026-09-27 at 10.05.31.png", "Screenshot 2026-09-27 at 10.09.02.png"];

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

function AuthorityActions({ copy }: { copy: (typeof labels)[keyof typeof labels] }) {
  return (
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="secondary">{copy.deny}</Button>
      <SplitButton size="sm" text={copy.once} onClick={() => undefined} menuLabel={copy.scope} menuSide="top"
        items={[{ key: "conversation", label: copy.conversation, onSelect: () => undefined }]} />
    </ButtonContainer>
  );
}

function Later({ copy }: { copy: (typeof labels)[keyof typeof labels] }) {
  return <Button size="sm" variant="borderless" aria-label={copy.later} title={copy.later}><ChevronDown aria-hidden="true" size="md" /></Button>;
}

function Authority({ context, error }: { context: ShowcaseRenderContext; error?: boolean }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel icon={<ShieldCheck aria-hidden="true" size="lg" />} title={copy.authority} onOpen={() => undefined}
      error={error ? copy.error : undefined}
      aside={<><Typo.Caption>+2</Typo.Caption><Later copy={copy} /></>}
      actions={<AuthorityActions copy={copy} />} />
  );
}

/** ComposerAuthorityDecisionSurface with a structured request: a question, examples and a risk Tag. */
function ApprovalRequest({ context, command }: { context: ShowcaseRenderContext; command?: boolean }) {
  const copy = labels[context.locale];
  return command ? (
    <ComposerDecisionPanel icon={<Terminal aria-hidden="true" size="lg" />} title={copy.command} onOpen={() => undefined}
      details={["rm -rf build && npm run build"]}
      aside={<><Tag tone="danger">{copy.high}</Tag><Later copy={copy} /></>}
      actions={<AuthorityActions copy={copy} />} />
  ) : (
    <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} title={copy.rename} onOpen={() => undefined}
      details={[...screenshots, copy.more]}
      aside={<><Tag tone="warning">{copy.medium}</Tag><Later copy={copy} /></>}
      actions={<AuthorityActions copy={copy} />} />
  );
}

export const stories: ShowcaseStory[] = [
  // ComposerPlanDecisionSurface: a plan waiting for acceptance.
  { name: "Plan decision", widths: ["375", "app"], render: (context) => <Plan context={context} /> },
  // ComposerAuthorityDecisionSurface: a question, examples with "+N more", a risk Tag, Deny and Allow once.
  { name: "Approval request", widths: ["375", "app"], render: (context) => <ApprovalRequest context={context} /> },
  { name: "High-risk command", widths: ["375", "app"], render: (context) => <ApprovalRequest context={context} command /> },
  // An agent without structured approvals: the legacy title, a pending count and compose-later aside.
  { name: "Authority decision", widths: ["375", "app"], render: (context) => <Authority context={context} /> },
  { name: "Failed decision", render: (context) => <Authority context={context} error /> },
];
