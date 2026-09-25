import { useState } from "react";
import { Button, ButtonContainer, CheckIcon, Stack, Typo } from "../../index";
import { Spinner } from "./Spinner";

export function SpinnerFixture() {
  const [busy, setBusy] = useState(true);
  const [run, setRun] = useState(0);

  return (
    <Stack gap="md" data-ds-fixture="spinner">
      <Stack key={run} align="row" gap="lg" cross="center" wrap>
        {([["sm", 14], ["md", 16], ["lg", 20], ["xl", 24], ["2xl", 32]] as const).map(([token, size]) => (
          <Stack key={size} gap="sm" cross="center">
            <Spinner size={size} />
            <Typo.Caption>{`icon-${token} · ${size}px`}</Typo.Caption>
          </Stack>
        ))}
      </Stack>
      <Spinner size={18} label="Loading records" />
      <ButtonContainer size="sm">
        <Button size="sm" disabled={busy} aria-busy={busy || undefined}>
          {busy ? <Spinner size={14} /> : <CheckIcon size="sm" aria-hidden />}
          {busy ? "Syncing" : "Synced"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setBusy(!busy)}>
          {busy ? "Complete loading" : "Load again"}
        </Button>
        <Button size="sm" variant="borderless" data-ds-motion="spinner-replay" onClick={() => setRun(run + 1)}>
          Replay
        </Button>
      </ButtonContainer>
    </Stack>
  );
}
