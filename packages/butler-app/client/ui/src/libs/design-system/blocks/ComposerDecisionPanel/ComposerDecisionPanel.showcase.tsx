import { useState } from "react";
import { ComposerCard } from "../ComposerCard";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Folder, ListChecks, ShieldCheck, Terminal } from "../../components/Icons";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { SplitButton } from "../SplitButton";
import { ComposerDecisionPanel, type ComposerDecisionPanelProps } from "./ComposerDecisionPanel";
import { BrowserApproval, BrowserHandoff } from "./ComposerDecisionPanel.showcaseParts";

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
    memory: "Save or change an instruction?", reread: "Butler just read outside content, so it asks again.",
    memoryInput: JSON.stringify({ kind: "instruction", text: "From now on, check the amount and deadline first on quote mails from vendors, and tell me right away when an amount rises more than 10% over the previous quote. Always draft replies politely, and list attachment names and sizes as well. Reflect this in the morning report too.", duration: "always", source: "Connected mail" }),
  },
  "ko-KR": {
    plan: "디자인 시스템 최종 정리 계획: 제품 CSS 모듈 제거와 픽셀 동등성 검증까지 한 번에 진행",
    instruction: "지시 추가", reject: "계속 계획", accept: "계획 승인",
    authority: "워크스페이스 밖의 파일 쓰기 허용 요청", later: "먼저 메시지 작성",
    deny: "거절", once: "이번만 허용", scope: "허용 범위", conversation: "이 대화에서 계속 허용",
    error: "결정을 전달하지 못했습니다.",
    rename: "'Desktop'의 파일 24개를 수정할까요?", more: "외 21개", showMore: "더보기", showLess: "접기", medium: "위험 보통",
    command: "'garden'에서 명령을 실행할까요?", high: "위험 높음",
    memory: "지침 저장 · 변경 허용할까요?", reread: "방금 외부에서 가져온 내용을 읽어서 다시 확인합니다.",
    memoryInput: JSON.stringify({ kind: "instruction", text: "다음부터 거래처에서 오는 견적 메일은 금액과 마감일을 먼저 확인하고, 금액이 지난 견적보다 10% 넘게 오르면 바로 알려 주세요. 회신 초안은 항상 정중한 존댓말로 쓰고, 첨부 파일 이름과 크기도 함께 정리해 주세요. 이 지침은 매일 오전 보고에도 반영해 주세요.", duration: "always", source: "연결된 메일" }),
  },
} as const;

const screenshots = ["Screenshot 2026-09-27 at 10.02.14.png", "Screenshot 2026-09-27 at 10.05.31.png", "Screenshot 2026-09-27 at 10.09.02.png"];

type Placement = ComposerDecisionPanelProps["placement"];

function Plan({ context, placement }: { context: ShowcaseRenderContext; placement?: Placement }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel placement={placement} icon={<ListChecks aria-hidden="true" size="lg" />} title={copy.plan} eyebrow={context.locale === "ko-KR" ? "계획" : "Plan"} onOpen={() => undefined}
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

/** ComposerAuthorityDecisionSurface with a structured request: a question, examples and a risk Tag, drawn literally (`2876x6` stays `x`). */
function ApprovalRequest({ context, command, placement }: { context: ShowcaseRenderContext; command?: boolean; placement?: Placement }) {
  const copy = labels[context.locale];
  return command ? (
    <ComposerDecisionPanel icon={<Terminal aria-hidden="true" size="lg" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"} title={copy.command} onOpen={() => undefined}
      details={[`magick shot.png -resize 2876x6 build/a->b.png && npm run build -- --out ${"dist/".repeat(16)}and a long tail of arguments that wraps`]} literal
      detailsShowMoreLabel={copy.showMore} detailsShowLessLabel={copy.showLess}
      aside={<><Tag tone="danger">{copy.high}</Tag></>}
      actions={<AuthorityActions copy={copy} />} />
  ) : (
    <ComposerDecisionPanel placement={placement} icon={<Folder aria-hidden="true" size="lg" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"} title={copy.rename} onOpen={() => undefined}
      details={[...screenshots, copy.more]} literal detailsShowMoreLabel={copy.showMore} detailsShowLessLabel={copy.showLess}
      aside={<><Tag tone="warning">{copy.medium}</Tag></>}
      actions={<AuthorityActions copy={copy} />} />
  );
}

/** A complete reviewed input as a later detail line: the clamp keeps the first lines, Show more reveals the whole input. */
function LongReviewedInput({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <ComposerDecisionPanel icon={<ShieldCheck aria-hidden="true" size="lg" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"} title={copy.memory} onOpen={() => undefined}
      details={[copy.reread, "update_explicit_memory", copy.memoryInput]}
      detailsShowMoreLabel={copy.showMore} detailsShowLessLabel={copy.showLess}
      aside={<><Tag tone="warning">{copy.medium}</Tag></>}
      actions={<AuthorityActions copy={copy} />} />
  );
}

export const stories: ShowcaseStory[] = [
  // ComposerPlanDecisionSurface: a plan waiting for acceptance.
  { name: "Plan decision", widths: ["375", "app"], render: (context) => <ComposerCard><Plan context={context} /></ComposerCard> },
  // ComposerAuthorityDecisionSurface: a question, examples with "+N more", a risk Tag, Deny and Allow once.
  { name: "Approval request", widths: ["375", "app"], render: (context) => <ComposerCard><ApprovalRequest context={context} /></ComposerCard> },
  { name: "High-risk command", widths: ["375", "app"], render: (context) => <ComposerCard><ApprovalRequest context={context} command /></ComposerCard> },
  // A short line, the tool, then a long reviewed input: clamped with Show more even though the first lines are short.
  { name: "Long reviewed input", widths: ["375", "app"], render: (context) => <ComposerCard><LongReviewedInput context={context} /></ComposerCard> },
  // An agent without structured approvals: the legacy title, a pending count.
  { name: "Authority decision", widths: ["375", "app"], render: (context) => <ComposerCard><Authority context={context} /></ComposerCard> },
  { name: "Failed decision", render: (context) => <ComposerCard><Authority context={context} error /></ComposerCard> },
  // media: the tab's page thumbnail beside the text (144px; 112px under 600px); under 420px it spans the text column under the details,
  // cropped from the page's top to --decision-media-narrow-height (140px). The approval draws a decoded ImageBitmap (canvas), the hand-off a still.
  { name: "Browser approval with the page", widths: ["320", "375", "app"], render: (context) => <ComposerCard><BrowserApproval {...context} /></ComposerCard> },
  { name: "Browser hand-off with the page", widths: ["320", "375", "app"], render: (context) => <ComposerCard><BrowserHandoff {...context} /></ComposerCard> },
  // placement="conversation": the decision where it was asked, in a flat Card radius="lg" with control-radius buttons.
  { name: "In conversation · approval request", widths: ["375", "app"], render: (context) => <ApprovalRequest context={context} placement="conversation" /> },
  { name: "In conversation · plan decision", widths: ["375", "app"], render: (context) => <Plan context={context} placement="conversation" /> },
  { name: "In conversation · browser approval", widths: ["320", "375", "app"], render: (context) => <BrowserApproval {...context} placement="conversation" /> },
];

function KeyboardDecision({ context }: { context: ShowcaseRenderContext }) {
  const [result, setResult] = useState("");
  const copy = labels[context.locale];
  if (result) return <Typo.Caption role="status">{result}</Typo.Caption>;
  return <ComposerCard><ComposerDecisionPanel icon={<ShieldCheck size="sm" />} eyebrow={context.locale === "ko-KR" ? "권한" : "Permission"}
    title={copy.authority} onOpen={() => undefined} details={["Exact target: workspace/output.txt"]}
    actions={(complete) => <ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" onClick={() => complete(() => setResult("Denied"))}>{copy.deny}</Button>
      <Button type="button" size="sm" onClick={() => complete(() => setResult("Allowed"))}>{copy.once}</Button>
    </ButtonContainer>} /></ComposerCard>;
}
stories.push({ name: "Keyboard · explicit confirmation", render: (context) => <KeyboardDecision context={context} /> });
