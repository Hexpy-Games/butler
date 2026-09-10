import { useState } from "react";
import { Button, ButtonContainer, CheckIcon, Stack, Typo } from "../../index";
import { Spinner } from "./Spinner";

export function SpinnerFixture() {
  const [busy, setBusy] = useState(true);

  return (
    <Stack gap="3" data-ds-fixture="spinner">
      <Stack align="row" gap="4" cross="center" wrap>
        {[14, 16, 18, 24, 32].map((size) => (
          <Stack key={size} gap="2" cross="center">
            <Spinner size={size} />
            <Typo.Caption>{size}px</Typo.Caption>
          </Stack>
        ))}
      </Stack>
      <Spinner size={18} label="Loading records" />
      <ButtonContainer size="sm">
        <Button size="sm" disabled={busy} aria-busy={busy || undefined}>
          {busy ? <Spinner size={14} /> : <CheckIcon size={14} aria-hidden />}
          {busy ? "Syncing" : "Synced"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setBusy(!busy)}>
          {busy ? "Complete loading" : "Load again"}
        </Button>
      </ButtonContainer>
    </Stack>
  );
}
