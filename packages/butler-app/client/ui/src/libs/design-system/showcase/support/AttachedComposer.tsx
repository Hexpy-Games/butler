import type { ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { Plus } from "../../components/Icons";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerPlanToggle,
  ComposerSendButton,
} from "../../blocks/ComposerCard";
import type { ShowcaseRenderContext } from "../types";

const labels = {
  "en-US": { draft: "Also check the settings pages at 375px.", more: "More options", plan: "Plan", send: "Send" },
  "ko-KR": { draft: "375px에서 설정 페이지도 확인해 주세요.", more: "추가 기능", plan: "계획", send: "전송" },
} as const;

/** Showcase host: the product composer with an adjunct panel attached above it. */
export function AttachedComposer({ adjunct, context }: { adjunct: ReactNode; context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <ComposerCard large adjunct={adjunct} onSubmit={(event) => event.preventDefault()}>
      <ComposerCardTextarea aria-label={copy.draft} defaultValue={copy.draft} rows={2} />
      <ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>
        <ComposerPlanToggle checked label={copy.plan} onCheckedChange={() => undefined} />
        <ComposerCardToolbarSpacer />
        <ComposerSendButton aria-label={copy.send} />
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
