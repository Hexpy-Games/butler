import { useState } from "react";
import { Button, Card, Stack, Typo } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { openBranchSource } from "@/app/messageNavigation";
import { MessageMarkdown } from "./MessageMarkdown";

export function SessionBranchSeed() {
  const seed = useButlerStore(state => state.summary?.branch_seed);
  const sessionId = useButlerStore(state => state.activeChatId);
  const [error, setError] = useState<string | null>(null);
  if (!seed) return null;
  return <Card data-test-class="session-branch-seed">
    <Stack gap="sm">
      <Typo.SectionTitle>이전 대화에서 이어온 내용</Typo.SectionTitle>
      <MessageMarkdown text={seed.summary} />
      <Typo.Caption>선택한 답변까지의 대화를 정리한 내용입니다. 원문은 기존 대화에 보존되어 있습니다.</Typo.Caption>
      <Button size="sm" variant="inline" onClick={() => {
        setError(null);
        void openBranchSource(sessionId).catch(cause => setError(cause instanceof Error ? cause.message : "원문을 열 수 없습니다."));
      }}>원본 답변으로 이동</Button>
      {error && <Typo.Caption role="alert">{error}</Typo.Caption>}
    </Stack>
  </Card>;
}
