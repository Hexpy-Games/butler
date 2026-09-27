import {
  Button,
  CheckIcon,
  Field,
  FieldError,
  FieldLabel,
  IconTile,
  Inline,
  Input,
  SetupWizardContent,
  Spinner,
  Stack,
  Typo,
} from "@/butler-ds";
import { PROVIDER_CARDS, type FirstRunProviderCardId } from "@/app/setupProviders.ts";
import { CardGlyph } from "./CardGlyph";
import { FirstRunBack } from "./FirstRunBack";
import { useKeyVerification, type KeyStatus } from "./useKeyVerification";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** One API key field, checked on paste; no name field and no Add button. */
export function FirstRunKeyForm({ cardId, flow }: { cardId: FirstRunProviderCardId; flow: FirstRunFlow }) {
  const { copy } = flow;
  const spec = PROVIDER_CARDS[cardId];
  const name = copy.providerNames[cardId];
  const key = useKeyVerification({
    providerId: spec.providerId ?? cardId,
    onVerified: (credentialId) => flow.connectKey(cardId, credentialId),
  });
  const bad = key.status === "invalid" || key.status === "noaccess" || key.status === "network";
  return (
    <SetupWizardContent width="wide">
      <Inline>
        <FirstRunBack label={copy.backToList} onClick={flow.backToList} />
      </Inline>
      <Inline gap="md">
        <IconTile size="md"><CardGlyph cardId={cardId} /></IconTile>
        <Typo.H4 as="h1">{copy.keyTitle(name)}</Typo.H4>
      </Inline>
      <Field data-test-class="first-run-key-field">
        <FieldLabel htmlFor="first-run-api-key">{copy.keyLabel}</FieldLabel>
        <Input
          aria-describedby="first-run-key-status"
          aria-invalid={bad}
          autoComplete="off"
          autoFocus
          id="first-run-api-key"
          spellCheck={false}
          type="password"
          value={key.value}
          onChange={(event) => key.change(event.target.value)}
        />
        <KeyStatusLine copy={copy} status={key.status} />
      </Field>
      <Inline gap="md">
        {spec.keyUrl ? (
          <Button asChild size="sm" variant="link">
            <a href={spec.keyUrl} rel="noreferrer" target="_blank">{`${copy.getKey} ↗`}</a>
          </Button>
        ) : null}
        <Typo.Caption tone="tertiary">{copy.keyStored}</Typo.Caption>
      </Inline>
    </SetupWizardContent>
  );
}

function KeyStatusLine({ copy, status }: { copy: FirstRunFlow["copy"]; status: KeyStatus }) {
  if (status === "invalid" || status === "noaccess" || status === "network") {
    const message = status === "invalid" ? copy.keyInvalid : status === "noaccess" ? copy.keyNoAccess : copy.keyNetwork;
    return <FieldError id="first-run-key-status" role="alert">{message}</FieldError>;
  }
  return (
    <Stack align="row" cross="center" gap="xs" id="first-run-key-status" role="status">
      {status === "checking" ? <Spinner size={14} /> : status === "valid" ? <CheckIcon size="sm" /> : null}
      <Typo.Caption tone={status === "valid" ? "success" : "secondary"}>
        {status === "checking" ? copy.checking : status === "valid" ? copy.keyValid : copy.keyHint}
      </Typo.Caption>
    </Stack>
  );
}
