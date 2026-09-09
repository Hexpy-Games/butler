import { useState } from "react";
import { DocumentReader } from "./DocumentReader";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { Stack } from "../../components/Stack";
import { DisclosureRow } from "../DisclosureRow";
import { KeyValueRow } from "../KeyValueRow";
import { MessageSquarePlus } from "../../components/Icons";

export function DocumentReaderFixture() {
  const [open, setOpen] = useState(false);
  return <DocumentReader
    header={<Stack gap="sm"><Typo.Caption>설계명세 · Sample</Typo.Caption>
      <Typo.H2>OAuth 연결과 모델 프리셋</Typo.H2></Stack>}
    facts={[
      { id: "type", label: "문서 종류", value: "설계명세" },
      { id: "status", label: "문서 상태", value: "검토 중" },
      { id: "updated", label: "최근 수정", value: "2026년 9월 9일 오후 3:40" },
      { id: "path", label: "원본 위치", value: "specs/model-presets-and-oauth.md" },
    ]}
    hint="원본 문서를 읽기 전용으로 보고 있습니다."
    action={<Button variant="outline"><MessageSquarePlus />대화에 참조하기</Button>}
    details={<DisclosureRow title="원본 식별 정보" surface="plain" open={open} onToggle={() => setOpen(!open)}>
      <KeyValueRow label="ID" value="SPEC-SAMPLE-OAUTH" />
    </DisclosureRow>}
  >
    <Typo.H3>이 문서의 목적</Typo.H3>
    <Typo.Body>모델 연결과 프리셋을 사용자가 쉽게 이해하고 관리할 수 있도록 동작과 검증 범위를 정리합니다.</Typo.Body>
    <Typo.H3>연결 상태와 프리셋</Typo.H3>
    <Typo.Body>인증 상태와 선택한 모델을 함께 표시합니다. 연결이 만료되면 재인증 경로를 안내하고 기존 프리셋은 보존합니다.</Typo.Body>
  </DocumentReader>;
}
