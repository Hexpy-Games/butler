import { useState } from "react";
import {
  Button,
  ButtonContainer,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Spinner,
  Stack,
  Typo,
} from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { KeyCheckFailure } from "@/app/setupConnection.ts";
import { MIN_KEY_LENGTH } from "../first-run/useKeyVerification";

type ReplaceStatus = "idle" | "checking" | KeyCheckFailure;

/**
 * The new key for a saved credential, checked with the provider on Save
 * (`verify: true`). A refused key stays in the field with the first-run
 * message for its code.
 */
export function SavedKeyReplaceField({ credentialId, onSubmit, onCancel }: {
  credentialId: string;
  /** Answers the failure, or null once the key is replaced (the row closes the field). */
  onSubmit: (apiKey: string) => Promise<KeyCheckFailure | null>;
  onCancel: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings.savedKeys;
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<ReplaceStatus>("idle");
  const inputId = `saved-key-${credentialId}`;
  const statusId = `${inputId}-status`;
  const checking = status === "checking";
  const failure = status === "idle" || checking ? null : status;
  const ready = value.trim().length >= MIN_KEY_LENGTH && !checking;

  async function submit() {
    if (!ready) return;
    setStatus("checking");
    const result = await onSubmit(value.trim());
    if (result) setStatus(result);
  }

  return (
    <Field data-test-class="saved-key-replace">
      <FieldLabel htmlFor={inputId}>{copy.newKey}</FieldLabel>
      <Input
        id={inputId}
        type="password"
        autoComplete="off"
        autoFocus
        spellCheck={false}
        aria-describedby={statusId}
        aria-invalid={failure !== null}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (failure) setStatus("idle");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape" && !checking) {
            onCancel();
          }
        }}
      />
      {failure ? (
        <FieldError id={statusId} role="alert">{appCopy.firstRun.keyErrors[failure]}</FieldError>
      ) : (
        <Stack align="row" cross="center" gap="xs" id={statusId} role="status">
          {checking ? <><Spinner size={14} /><Typo.Caption tone="secondary">{copy.checking}</Typo.Caption></> : null}
        </Stack>
      )}
      <ButtonContainer size="sm">
        <Button type="button" variant="outline" size="sm" disabled={checking} onClick={onCancel}>{copy.cancel}</Button>
        <Button type="button" size="sm" disabled={!ready} onClick={() => void submit()}>{copy.save}</Button>
      </ButtonContainer>
    </Field>
  );
}
