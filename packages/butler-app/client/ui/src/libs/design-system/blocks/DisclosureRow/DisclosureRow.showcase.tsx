import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { FileText, Wrench } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { KeyValueRow } from "../KeyValueRow";
import { DisclosureRow } from "./DisclosureRow";

export const meta: ShowcaseMeta = {
  title: "DisclosureRow",
  category: "Conversation & Activity",
  tags: ["disclosure", "expand", "tool", "details", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    search: "Search", files: "Project files", result: "Read-only file search completed: 14 matches in 6 files.",
    path: "packages/butler-app/client/ui/src/libs/design-system/tokens.css", counts: "+12 −3",
    details: "Source details", revision: "Revision", updated: "Updated", evidence: "3 sources",
    log: "model_turn · gpt-5.1", logMeta: "8 sections / 42K context chars / 3.1K response chars",
  },
  "ko-KR": {
    search: "검색", files: "프로젝트 파일", result: "읽기 전용 파일 검색 완료: 파일 6개에서 14건.",
    path: "packages/butler-app/client/ui/src/libs/design-system/tokens.css", counts: "+12 −3",
    details: "출처 정보", revision: "리비전", updated: "수정", evidence: "출처 3개",
    log: "model_turn · gpt-5.1", logMeta: "섹션 8개 / 컨텍스트 4.2만 자 / 응답 3.1천 자",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Local open state; plain rows start closed like changed files and source details. */
function Toggle({ surface, children, title, icon, meta, description }: {
  surface?: "plain" | "selection"; children: ReactNode; title: string; icon?: ReactNode; meta?: string; description?: string;
}) {
  const [open, setOpen] = useState(surface !== "plain");
  return (
    <DisclosureRow description={description} icon={icon} meta={meta} open={open} surface={surface} title={title}
      onToggle={() => setOpen((value) => !value)}>
      {children}
    </DisclosureRow>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Tool call (selection surface)",
    states: ["expanded"],
    render: (context) => (
      <Toggle icon={<Wrench size="md" />} title={text(context).search} description={text(context).files} meta={text(context).evidence}>
        <Typo.Caption>{text(context).result}</Typo.Caption>
      </Toggle>
    ),
  },
  {
    // MessageChangedFileRow: plain surface, path title and +/- counts.
    name: "Changed file (plain)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Toggle surface="plain" icon={<FileText size="lg" />} title={text(context).path} meta={text(context).counts}>
        <Typo.Code>{"--motion-fast: 120ms;"}</Typo.Code>
      </Toggle>
    ),
  },
  {
    name: "Source details and developer log",
    render: (context) => (
      <Stack gap="sm">
        <Toggle surface="plain" title={text(context).details}>
          <Stack gap="xs">
            <KeyValueRow label={text(context).revision} value="r42" valueTextSize="caption" />
            <KeyValueRow label={text(context).updated} value="2026-09-25" valueTextSize="caption" />
          </Stack>
        </Toggle>
        <Toggle title={text(context).log} meta={text(context).logMeta}>
          <Typo.Caption>{text(context).evidence}</Typo.Caption>
        </Toggle>
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "open"],
  render: (context) => (
    <DisclosureRow icon={<Wrench size="md" />} open={context.state === "open"} title={text(context).search} onToggle={() => undefined}>
      <Typo.Caption>{text(context).result}</Typo.Caption>
    </DisclosureRow>
  ),
};
