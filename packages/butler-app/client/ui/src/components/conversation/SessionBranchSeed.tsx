import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useState } from "react";
import { Button, Card, Stack, Typo } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { openBranchSource } from "@/app/messageNavigation";
import { MessageMarkdown } from "./MessageMarkdown";

export function SessionBranchSeed() {
  useAppLocale();
  const seed = useButlerStore(state => state.summary?.branch_seed);
  const sessionId = useButlerStore(state => state.activeChatId);
  const [error, setError] = useState<string | null>(null);
  if (!seed) return null;
  return <Card data-test-class="session-branch-seed">
    <Stack gap="sm">
      <Typo.SectionTitle>{appCopy.interfaceDetails.branchSourceTitle}</Typo.SectionTitle>
      <MessageMarkdown text={seed.summary} />
      <Typo.Caption>{appCopy.interfaceDetails.branchSourceDescription}</Typo.Caption>
      <Button size="sm" variant="inline" onClick={() => {
        setError(null);
        void openBranchSource(sessionId).catch(cause => setError(cause instanceof Error ? cause.message : appCopy.interfaceDetails.branchSourceFailed));
      }}>{appCopy.interfaceDetails.branchSource}</Button>
      {error && <Typo.Caption role="alert">{error}</Typo.Caption>}
    </Stack>
  </Card>;
}
