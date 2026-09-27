import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SplitButton } from "./SplitButton";

export const meta: ShowcaseMeta = {
  title: "SplitButton",
  category: "Composer",
  tags: ["action", "button", "menu", "split", "approval"],
  status: "stable",
};

const copy = {
  "en-US": {
    deny: "Deny", once: "Allow once", more: "More allow options", conversation: "Allow for this conversation",
    scope: "Write files in ~/projects/butler", note: "Butler will not ask again in this conversation.",
    run: "Run now", runOptions: "Run options", later: "Run in 10 minutes", dry: "Dry run", last: "Last action",
  },
  "ko-KR": {
    deny: "거부", once: "한 번 허용", more: "허용 옵션 더 보기", conversation: "이 대화에서 허용",
    scope: "~/projects/butler 안의 파일 쓰기", note: "이 대화에서는 다시 묻지 않습니다.",
    run: "지금 실행", runOptions: "실행 옵션", later: "10분 뒤 실행", dry: "시험 실행", last: "마지막 동작",
  },
} as const;

function Approval({ locale, pending = false, scope = true }: ShowcaseRenderContext & { pending?: boolean; scope?: boolean }) {
  const text = copy[locale];
  const [last, setLast] = useState("—");
  return (
    <Stack gap="sm">
      <ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="secondary" disabled={pending} text={text.deny} onClick={() => setLast(text.deny)} />
        <SplitButton size="sm" text={text.once} disabled={pending} menuLabel={text.more} menuSide="top"
          onClick={() => setLast(text.once)}
          items={[{ key: "conversation", label: text.conversation, description: [text.scope, text.note], disabled: !scope, onSelect: () => setLast(text.conversation) }]} />
      </ButtonContainer>
      <Typo.Caption tone="secondary">{`${text.last}: ${last}`}</Typo.Caption>
    </Stack>
  );
}

function Outline({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  return (
    <ButtonContainer size="default">
      <SplitButton variant="outline" text={text.run} menuLabel={text.runOptions} onClick={() => undefined}
        items={[
          { key: "later", label: text.later, onSelect: () => undefined },
          { key: "dry", label: text.dry, onSelect: () => undefined },
        ]} />
    </ButtonContainer>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Approval (primary, small, menu above)", states: ["hover", "open"], render: (context) => <Approval {...context} /> },
  { name: "Outline", render: (context) => <Outline {...context} /> },
  { name: "Menu unavailable", render: (context) => <Approval {...context} scope={false} /> },
  { name: "Disabled while pending", states: ["disabled"], render: (context) => <Approval {...context} pending /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: ["primary", "outline"],
  render: (context) => (
    <SplitButton text={copy[context.locale].once} menuLabel={copy[context.locale].more} disabled={context.state === "disabled"}
      variant={context.variant === "outline" ? "outline" : "primary"}
      items={[{ key: "conversation", label: copy[context.locale].conversation, onSelect: () => undefined }]} onClick={() => undefined} />
  ),
};
