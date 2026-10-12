import { faviconSrc } from "@/app/favicons.ts";
import {
  Button,
  CheckIcon,
  Field,
  FieldError,
  FieldLabel,
  Inline,
  Input,
  SetupWizardStepAction,
  Spinner,
  Stack,
  InlineReference,
  Tooltip,
  Typo,
} from "@/butler-ds";
import { PROVIDER_CARDS, type FirstRunProviderCardId } from "@/app/setupProviders.ts";
import { CardGlyph } from "./CardGlyph";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { KeyCheckFailure } from "@/app/setupConnection.ts";
import { RETRYABLE_KEY_FAILURES, useKeyVerification, type KeyStatus } from "./useKeyVerification";
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
  const bad = isKeyFailure(key.status);
  const connected = Boolean(flow.commit.connected);
  const connecting = Boolean(flow.commit.pending) && !connected;
  return (
    <FirstRunStepCard flow={flow} contentKey={`key:${cardId}`} icon={<CardGlyph cardId={cardId} />} title={copy.keyTitle(name)}
      description={copy.keyHint} onBack={flow.backToList}
      actions={<Tooltip label={connected ? undefined : copy.connectFirst}>
        <SetupWizardStepAction forward disabled={!connected} onClick={flow.toReply}>{connecting ? copy.connecting : copy.next}</SetupWizardStepAction>
      </Tooltip>}
    >
      <Field data-test-class="first-run-key-field">
        <FieldLabel htmlFor="first-run-api-key">{copy.keyLabel}</FieldLabel>
        <Input
          aria-describedby="first-run-key-status"
          aria-invalid={bad}
          disabled={Boolean(flow.commit.connected)}
          autoComplete="off"
          autoFocus
          id="first-run-api-key"
          spellCheck={false}
          type="password"
          value={key.value}
          onChange={(event) => key.change(event.target.value)}
        />
        <KeyStatusLine copy={copy} status={connected ? "valid" : connecting ? "checking" : key.status} onRetry={key.retry} />
      </Field>
      <Inline gap="md">
        {spec.keyUrl ? <Typo.Body as="span"><InlineReference kind="external" href={spec.keyUrl} iconSrc={faviconSrc(spec.keyUrl)}>{copy.getKey}</InlineReference></Typo.Body> : null}
        <Typo.Caption tone="tertiary">{copy.keyStored}</Typo.Caption>
      </Inline>
    </FirstRunStepCard>
  );
}

function isKeyFailure(status: KeyStatus): status is KeyCheckFailure {
  return status !== "idle" && status !== "checking" && status !== "valid" && status !== "saved";
}

function KeyStatusLine({ copy, status, onRetry }: { copy: FirstRunFlow["copy"]; status: KeyStatus; onRetry: () => void }) {
  if (isKeyFailure(status)) {
    return (
      <Stack gap="xs">
        <FieldError id="first-run-key-status" role="alert">{copy.keyErrors[status]}</FieldError>
        {RETRYABLE_KEY_FAILURES.includes(status) ? (
          <Inline>
            <Button size="sm" type="button" variant="link" onClick={onRetry}>{copy.retry}</Button>
          </Inline>
        ) : null}
      </Stack>
    );
  }
  const done = status === "valid" || status === "saved";
  return (
    <Stack align="row" cross="center" gap="xs" id="first-run-key-status" role="status">
      {status === "checking" ? <Spinner size={14} /> : done ? <CheckIcon size="sm" /> : null}
      <Typo.Caption tone={done ? "success" : "secondary"}>
        {status === "checking" ? copy.checking : status === "valid" ? copy.keyValid : status === "saved" ? copy.keySaved : copy.keyHint}
      </Typo.Caption>
    </Stack>
  );
}
