import { Button, ButtonContainer, Input, SettingsField, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { OpenAIOAuthLoginResult } from "./modelManagementApi";

interface HostedOAuthFieldsProps {
  callbackUrl: string;
  login: OpenAIOAuthLoginResult | null;
  busy: boolean;
  onCallbackUrlChange: (value: string) => void;
  onCheck: () => void;
  onCopyUrl: () => void;
  onOpenUrl: () => void;
  onRestart: () => void;
  onSubmitCallback: () => void;
}

export function HostedOAuthFields({
  callbackUrl,
  login,
  busy,
  onCallbackUrlChange,
  onCheck,
  onCopyUrl,
  onOpenUrl,
  onRestart,
  onSubmitCallback,
}: HostedOAuthFieldsProps) {
  const copy = appCopy.settings.modelManagement;
  const pending = login?.status === "pending" || login?.status === "starting";
  const failed = login?.status === "failed" || login?.status === "cancelled";
  const complete = login?.status === "completed" || login?.status === "profile_exists";
  const status = complete
    ? copy.oauthComplete
    : failed
      ? copy.oauthFailed
      : pending
        ? copy.oauthPending
        : copy.oauthReady;

  return (
    <Stack gap="md">
      <Typo.Body>{status}</Typo.Body>
      {login?.auth_url && (
        <SettingsField
          label={copy.oauthLink}
          control={<Input value={login.auth_url} readOnly />}
        />
      )}
      {login?.auth_url && (
        <ButtonContainer size="sm">
          <Button type="button" variant="outline" onClick={onOpenUrl}>
            {copy.oauthOpen}
          </Button>
          <Button type="button" variant="outline" onClick={onCopyUrl}>
            {copy.oauthCopy}
          </Button>
        </ButtonContainer>
      )}
      {pending && (
        <SettingsField
          label={copy.oauthCallback}
          control={<Input value={callbackUrl} onChange={(event) => onCallbackUrlChange(event.target.value)} />}
        />
      )}
      {pending && (
        <ButtonContainer size="sm">
          <Button type="button" variant="outline" disabled={busy || !callbackUrl.trim()} onClick={onSubmitCallback}>
            {copy.oauthSubmitCallback}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCheck}>
            {copy.oauthCheck}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onRestart}>
            {copy.oauthRetry}
          </Button>
        </ButtonContainer>
      )}
      {failed && (
        <ButtonContainer size="sm">
          <Button type="button" variant="outline" disabled={busy} onClick={onRestart}>
            {copy.oauthRetry}
          </Button>
        </ButtonContainer>
      )}
    </Stack>
  );
}
