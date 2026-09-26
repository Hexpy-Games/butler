import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { MessageSquarePlus } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DisclosureRow } from "../DisclosureRow";
import { KeyValueRow } from "../KeyValueRow";
import { DocumentReader } from "./DocumentReader";

export const meta: ShowcaseMeta = {
  title: "DocumentReader",
  category: "Documents & Artifacts",
  tags: ["document", "reader", "dialog", "spec", "facts"],
  status: "stable",
};

const labels = {
  "en-US": {
    kind: "Spec", title: "OAuth connection and model presets", facts: [["Type", "Spec"], ["Status", "In review"], ["Updated", "Sep 9, 2026, 3:40 PM"], ["Source", "specs/model-presets-and-oauth.md"]],
    hint: "You are reading the source document; it is read-only.", reference: "Reference in chat", details: "Source details",
    purposeTitle: "Why this document exists", purpose: "Explain how model connections and presets behave so people can understand and manage them, and what the checks cover.",
    stateTitle: "Connection state and presets", state: "Show the sign-in state with the chosen model. When a connection expires, guide re-authentication and keep existing presets.",
  },
  "ko-KR": {
    kind: "설계명세", title: "OAuth 연결과 모델 프리셋", facts: [["문서 종류", "설계명세"], ["문서 상태", "검토 중"], ["최근 수정", "2026년 9월 9일 오후 3:40"], ["원본 위치", "specs/model-presets-and-oauth.md"]],
    hint: "원본 문서를 읽기 전용으로 보고 있습니다.", reference: "대화에 참조하기", details: "원본 식별 정보",
    purposeTitle: "이 문서의 목적", purpose: "모델 연결과 프리셋을 사용자가 쉽게 이해하고 관리할 수 있도록 동작과 검증 범위를 정리합니다.",
    stateTitle: "연결 상태와 프리셋", state: "인증 상태와 선택한 모델을 함께 표시합니다. 연결이 만료되면 재인증 경로를 안내하고 기존 프리셋은 보존합니다.",
  },
} as const;

/** ProjectDocumentDialog body: header, facts, source details, then the document. */
function Reader({ context }: { context: ShowcaseRenderContext }) {
  const [open, setOpen] = useState(false);
  const copy = labels[context.locale];
  return (
    <DocumentReader
      header={<Stack gap="sm"><Typo.Caption>{`${copy.kind} · SPEC-SAMPLE-OAUTH`}</Typo.Caption><Typo.H2>{copy.title}</Typo.H2></Stack>}
      facts={copy.facts.map(([label, value]) => ({ id: label, label, value }))}
      hint={copy.hint}
      action={<Button variant="outline"><MessageSquarePlus />{copy.reference}</Button>}
      details={(
        <DisclosureRow title={copy.details} surface="plain" open={open} onToggle={() => setOpen(!open)}>
          <KeyValueRow label="ID" value="SPEC-SAMPLE-OAUTH" valueTextSize="caption" />
        </DisclosureRow>
      )}
    >
      <Typo.H3>{copy.purposeTitle}</Typo.H3>
      <Typo.Body>{copy.purpose}</Typo.Body>
      <Typo.H3>{copy.stateTitle}</Typo.H3>
      <Typo.Body>{copy.state}</Typo.Body>
    </DocumentReader>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Spec reader", widths: ["375", "app", "wide"], render: (context) => <Reader context={context} /> },
];
