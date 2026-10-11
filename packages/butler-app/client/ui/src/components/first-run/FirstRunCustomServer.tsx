import { useState } from "react";
import {
  SetupWizardStepAction,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from "@/butler-ds";
import { customModelOptions } from "@/app/setupProviders.ts";
import { discoverLocalModels } from "@/components/settings/localModelApi";
import { CardGlyph } from "./CardGlyph";
import { FirstRunStepCard } from "./FirstRunStepCard";
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
    <FirstRunStepCard flow={flow} contentKey="custom" icon={<CardGlyph cardId="other" />} title={copy.customTitle}
      description={copy.customBody} onBack={flow.backToList}
      actions={<SetupWizardStepAction forward disabled={!serverUrl.trim() || busy} onClick={() => void connect()}>
        {busy ? copy.checking : copy.customConnect}
      </SetupWizardStepAction>}
    >
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
        {failed ? <FieldError>{copy.keyErrors.network}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor="first-run-server-key">{copy.customKey}</FieldLabel>
        <Input autoComplete="off" id="first-run-server-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
      </Field>
    </FirstRunStepCard>
  );
}
