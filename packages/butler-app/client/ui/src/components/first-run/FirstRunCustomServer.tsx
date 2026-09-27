import { useState } from "react";
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  IconTile,
  Inline,
  Input,
  SetupWizardContent,
  Typo,
} from "@/butler-ds";
import { customModelOptions } from "@/app/setupProviders.ts";
import { discoverLocalModels } from "@/components/settings/localModelApi";
import { CardGlyph } from "./CardGlyph";
import { FirstRunBack } from "./FirstRunBack";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Other (OpenAI-compatible): a server address and an optional key, then its models. */
export function FirstRunCustomServer({ flow }: { flow: FirstRunFlow }) {
  const { copy } = flow;
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function connect(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const result = await discoverLocalModels("custom", serverUrl.trim(), apiKey.trim() || undefined);
      flow.showCustomModels(customModelOptions(result.server_url || serverUrl.trim(), result.models), apiKey.trim() || undefined);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupWizardContent width="wide">
      <Inline>
        <FirstRunBack label={copy.backToList} onClick={flow.backToList} />
      </Inline>
      <Inline gap="md">
        <IconTile size="md"><CardGlyph cardId="other" /></IconTile>
        <Typo.H4 as="h1">{copy.customTitle}</Typo.H4>
      </Inline>
      <Field>
        <FieldLabel htmlFor="first-run-server-url">{copy.customUrl}</FieldLabel>
        <Input
          aria-invalid={failed}
          autoComplete="off"
          autoFocus
          id="first-run-server-url"
          placeholder="http://127.0.0.1:8080/v1"
          type="url"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
        />
        {failed ? <FieldError>{copy.keyNetwork}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="first-run-server-key">{copy.customKey}</FieldLabel>
        <Input autoComplete="off" id="first-run-server-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
      </Field>
      <Button disabled={!serverUrl.trim() || busy} size="lg" stretch type="button" onClick={() => void connect()}>
        {busy ? copy.checking : copy.customConnect}
      </Button>
    </SetupWizardContent>
  );
}
