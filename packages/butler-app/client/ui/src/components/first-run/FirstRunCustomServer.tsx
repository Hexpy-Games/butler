import { useState } from "react";
import {
  Button,
  CheckCircle2,
  ChoiceCard,
  ChoiceCardList,
  Field,
  FieldError,
  FieldLabel,
  Inline,
  Input,
  Notice,
  Server,
  SetupWizardStepAction,
  Spinner,
  Typo,
} from "@/butler-ds";
import { customModelOptions } from "@/app/setupProviders.ts";
import { discoverLocalModels } from "@/components/settings/localModelApi";
import { ModelLogo } from "./FirstRunModelPicker";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

const SERVER = "server";

/**
 * Other ②: models found on this computer (Ollama, LM Studio) as choices, then a typed
 * OpenAI-compatible server. A model connects with Next; the server choice finds its models first.
 */
export function FirstRunCustomServer({ flow }: { flow: FirstRunFlow }) {
  const { copy, local, commit } = flow;
  const [choice, setChoice] = useState<string | null>(null);
  const server = useServerForm(flow);
  const model = choice === SERVER ? undefined : local.options.find((option) => option.key === choice) ?? local.options[0];
  const connected = Boolean(commit.connected);
  const connecting = Boolean(commit.pending) && !connected;
  const action = connected ? <SetupWizardStepAction forward onClick={flow.toReply}>{copy.next}</SetupWizardStepAction>
    : model ? <SetupWizardStepAction forward disabled={connecting} onClick={() => flow.connectAndAdvance("other", model)}>
      {connecting ? copy.connecting : copy.next}
    </SetupWizardStepAction>
      : <SetupWizardStepAction forward disabled={!server.url.trim() || server.busy} onClick={() => void server.connect()}>
        {server.busy ? copy.checking : copy.customConnect}
      </SetupWizardStepAction>;
  return (
    <FirstRunStepCard flow={flow} contentKey="custom" title={copy.otherTitle}
      titleId="first-run-other-title" description={copy.otherBody} onBack={flow.backToList} actions={action}
      footerStart={model && !connected ? <Typo.Caption tone="tertiary">{copy.localNote}</Typo.Caption> : undefined}
    >
      {connected ? <Notice tone="neutral" icon={<CheckCircle2 size="md" />} message={copy.keyValid} /> : <>
        {local.options.length ? (
          <ChoiceCardList aria-labelledby="first-run-other-title" role="radiogroup">
            {local.options.map((option) => (
              <ChoiceCard aria-checked={option.key === model?.key} chevron={false} data-model-key={option.key} icon={<ModelLogo logo={option.logo} />}
                key={option.key} meta={option.sizeLabel} role="radio" selected={option.key === model?.key} state={connecting ? "disabled" : "default"}
                title={option.modelId} onClick={() => setChoice(option.key)} />
            ))}
            <ChoiceCard aria-checked={!model} chevron={false} data-model-key={SERVER} description={copy.customBody} icon={<Server size="md" />}
              role="radio" selected={!model} state={connecting ? "disabled" : "default"} title={copy.otherServer} onClick={() => setChoice(SERVER)} />
          </ChoiceCardList>
        ) : <LocalSearch flow={flow} />}
        {model ? null : <ServerFields copy={copy} form={server} />}
      </>}
    </FirstRunStepCard>
  );
}

/** No local model yet: say how to get one, with Check again. */
function LocalSearch({ flow }: { flow: FirstRunFlow }) {
  const { copy, local } = flow;
  if (local.checking) return <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{copy.checking}</Typo.Caption></Inline>;
  return (
    <Inline>
      <Typo.Caption tone="secondary">{copy.localMissing}</Typo.Caption>
      <Button size="sm" variant="link" onClick={local.rescan}>{copy.rescan}</Button>
    </Inline>
  );
}

function useServerForm(flow: FirstRunFlow) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function connect(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const result = await discoverLocalModels("custom", url.trim(), apiKey.trim() || undefined);
      flow.showCustomModels(customModelOptions(result.server_url || url.trim(), result.models), apiKey.trim() || undefined);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return { url, setUrl, apiKey, setApiKey, busy, failed, connect };
}

function ServerFields({ copy, form }: { copy: FirstRunFlow["copy"]; form: ReturnType<typeof useServerForm> }) {
  return <>
    <Field>
      <FieldLabel htmlFor="first-run-server-url">{copy.customUrl}</FieldLabel>
      <Input aria-invalid={form.failed} autoComplete="off" id="first-run-server-url" placeholder="http://127.0.0.1:8080/v1" type="url"
        value={form.url} onChange={(event) => form.setUrl(event.target.value)} />
      {form.failed ? <FieldError>{copy.keyErrors.network}</FieldError> : null}
    </Field>
    <Field>
      <FieldLabel htmlFor="first-run-server-key">{copy.customKey}</FieldLabel>
      <Input autoComplete="off" id="first-run-server-key" type="password" value={form.apiKey} onChange={(event) => form.setApiKey(event.target.value)} />
    </Field>
  </>;
}
