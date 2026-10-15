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
    longFiles: "Project files, settings and the three most recent conversation transcripts",
  },
  "ko-KR": {
    search: "검색", files: "프로젝트 파일", result: "읽기 전용 파일 검색 완료: 파일 6개에서 14건.",
    path: "packages/butler-app/client/ui/src/libs/design-system/tokens.css", counts: "+12 −3",
    details: "출처 정보", revision: "리비전", updated: "수정", evidence: "출처 3개",
    log: "model_turn · gpt-5.1", logMeta: "섹션 8개 / 컨텍스트 4.2만 자 / 응답 3.1천 자",
    longFiles: "프로젝트 파일, 설정과 최근 대화 기록 세 개",
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
        <Toggle title={text(context).log} description={text(context).files} meta={text(context).logMeta}>
          <Typo.Caption>{text(context).evidence}</Typo.Caption>
        </Toggle>
      </Stack>
    ),
  },
];

/**
 * Every surface and content shape in every interaction state. The title line
 * must sit centred in the hover/open fill, and plain rows keep the chevron on
 * the content edge with the fill bleeding past it (see README "Geometry").
 */
const MATRIX_VARIANTS = [
  "selection",
  "selection + description",
  "plain",
  "plain + icon + meta",
  "plain + long meta",
] as const;

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "open"],
  variants: [...MATRIX_VARIANTS],
  render: (context) => {
    const copy = text(context);
    const plain = context.variant.startsWith("plain");
    const open = context.state === "open";
    const shared = { open, onToggle: () => undefined, surface: plain ? "plain" as const : "selection" as const };
    switch (context.variant) {
      case "selection + description":
        return <DisclosureRow {...shared} icon={<Wrench size="md" />} title={copy.search} description={copy.longFiles}>
          <Typo.Caption>{copy.result}</Typo.Caption>
        </DisclosureRow>;
      case "plain":
        return <DisclosureRow {...shared} title={copy.details}><Typo.Caption>{copy.result}</Typo.Caption></DisclosureRow>;
      case "plain + icon + meta":
        return <DisclosureRow {...shared} icon={<FileText size="lg" />} title={copy.path} meta={copy.counts}>
          <Typo.Code>{"--motion-fast: 120ms;"}</Typo.Code>
        </DisclosureRow>;
      case "plain + long meta":
        return <DisclosureRow {...shared} title={copy.log} meta={copy.logMeta}><Typo.Caption>{copy.evidence}</Typo.Caption></DisclosureRow>;
      default:
        return <DisclosureRow {...shared} icon={<Wrench size="md" />} title={copy.search}><Typo.Caption>{copy.result}</Typo.Caption></DisclosureRow>;
    }
  },
};
