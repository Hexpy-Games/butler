import { useState } from "react";
import type { ReactNode } from "react";
import { ComposerCard, ComposerCardToolbar, ComposerCardTextarea, ComposerSendButton } from "../ComposerCard";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Folder, ListChecks, ShieldCheck, Terminal } from "../../components/Icons";
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
    error: "Could not submit the decision. Try again.",
    rename: "Edit 24 files in 'Desktop'?", more: "+21 more", showMore: "Show more", showLess: "Show less", medium: "Medium risk",
    command: "Run a command in 'garden'?", high: "High risk",
  },
  "ko-KR": {
    plan: "디자인 시스템 최종 정리 계획: 제품 CSS 모듈 제거와 픽셀 동등성 검증까지 한 번에 진행",
    instruction: "지시 추가", reject: "계속 계획", accept: "계획 승인",
    authority: "워크스페이스 밖의 파일 쓰기 허용 요청", later: "먼저 메시지 작성",
    deny: "거절", once: "이번만 허용", scope: "허용 범위", conversation: "이 대화에서 계속 허용",
    error: "결정을 전달하지 못했습니다.",
    rename: "'Desktop'의 파일 24개를 수정할까요?", more: "외 21개", showMore: "더보기", showLess: "접기", medium: "위험 보통",
    command: "'garden'에서 명령을 실행할까요?", high: "위험 높음",
  },
} as const;

const screenshots = ["Screenshot 2026-09-27 at 10.02.14.png", "Screenshot 2026-09-27 at 10.05.31.png", "Screenshot 2026-09-27 at 10.09.02.png"];

function Plan({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel icon={<ListChecks aria-hidden="true" size="lg" />} title={copy.plan} eyebrow={context.locale === "ko-KR" ? "계획" : "Plan"} onOpen={() => undefined}
      actions={<ButtonContainer size="sm" justify="end">
        <Button type="button" size="sm" variant="outline">{copy.instruction}</Button>
        <Button type="button" size="sm" variant="secondary">{copy.reject}</Button>
        <Button type="button" size="sm">{copy.accept}</Button>
      </ButtonContainer>} />
  );
}

function AuthorityActions({ copy }: { copy: (typeof labels)[keyof typeof labels] }) {
  return (
    <ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary">{copy.deny}</Button>
      <SplitButton size="sm" text={copy.once} onClick={() => undefined} menuLabel={copy.scope} menuSide="top"
        items={[{ key: "conversation", label: copy.conversation, onSelect: () => undefined }]} />
    </ButtonContainer>
  );
}

function Authority({ context, error }: { context: ShowcaseRenderContext; error?: boolean }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel icon={<ShieldCheck aria-hidden="true" size="lg" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"} title={copy.authority} onOpen={() => undefined}
      error={error ? copy.error : undefined}
      aside={<><Typo.Caption>+2</Typo.Caption></>}
      actions={<AuthorityActions copy={copy} />} />
  );
}

/** ComposerAuthorityDecisionSurface with a structured request: a question, examples and a risk Tag. */
function ApprovalRequest({ context, command }: { context: ShowcaseRenderContext; command?: boolean }) {
  const copy = labels[context.locale];
  return command ? (
    <ComposerDecisionPanel icon={<Terminal aria-hidden="true" size="lg" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"} title={copy.command} onOpen={() => undefined}
      details={[`rm -rf build && npm run build -- --out ${"dist/".repeat(16)}and a long tail of arguments that wraps`]}
      detailsShowMoreLabel={copy.showMore} detailsShowLessLabel={copy.showLess}
      aside={<><Tag tone="danger">{copy.high}</Tag></>}
      actions={<AuthorityActions copy={copy} />} />
  ) : (
    <ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"} title={copy.rename} onOpen={() => undefined}
      details={[...screenshots, copy.more]} detailsShowMoreLabel={copy.showMore} detailsShowLessLabel={copy.showLess}
      aside={<><Tag tone="warning">{copy.medium}</Tag></>}
      actions={<AuthorityActions copy={copy} />} />
  );
}

export const stories: ShowcaseStory[] = [
  // ComposerPlanDecisionSurface: a plan waiting for acceptance.
  { name: "Plan decision", widths: ["375", "app"], render: (context) => <DecisionComposer><Plan context={context} /></DecisionComposer> },
  // ComposerAuthorityDecisionSurface: a question, examples with "+N more", a risk Tag, Deny and Allow once.
  { name: "Approval request", widths: ["375", "app"], render: (context) => <DecisionComposer><ApprovalRequest context={context} /></DecisionComposer> },
  { name: "High-risk command", widths: ["375", "app"], render: (context) => <DecisionComposer><ApprovalRequest context={context} command /></DecisionComposer> },
  // An agent without structured approvals: the legacy title, a pending count.
  { name: "Authority decision", widths: ["375", "app"], render: (context) => <DecisionComposer><Authority context={context} /></DecisionComposer> },
  { name: "Failed decision", render: (context) => <DecisionComposer><Authority context={context} error /></DecisionComposer> },
];

function KeyboardDecision({ context }: { context: ShowcaseRenderContext }) {
  const [result, setResult] = useState("");
  const copy = labels[context.locale];
  if (result) return <Typo.Caption role="status">{result}</Typo.Caption>;
  return <DecisionComposer><ComposerDecisionPanel icon={<ShieldCheck size="sm" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"}
    title={copy.authority} onOpen={() => undefined} details={["Exact target: workspace/output.txt"]}
    actions={(complete) => <ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" onClick={() => complete(() => setResult("Denied"))}>{copy.deny}</Button>
      <Button type="button" size="sm" onClick={() => complete(() => setResult("Allowed"))}>{copy.once}</Button>
    </ButtonContainer>} /></DecisionComposer>;
}
stories.push({ name: "Keyboard · explicit confirmation", render: (context) => <KeyboardDecision context={context} /> });

function DecisionComposer({ children }: { children: ReactNode }) {
  return <ComposerCard panel={children} controls={<ComposerCardToolbar><ComposerSendButton aria-label="Send" disabled /></ComposerCardToolbar>}>
    <ComposerCardTextarea aria-label="Message" placeholder="Write a message" />
  </ComposerCard>;
}
