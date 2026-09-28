import { useState } from "react";
import {
  Button,
  ChoiceCard,
  ChoiceCardList,
  IconTile,
  Inline,
  ProviderLogo,
  Server,
  SetupWizardContent,
  Stack,
  Typo,
} from "@/butler-ds";
import type { FirstRunProviderCardId, LocalModelOption, ProviderCardLogo } from "@/app/setupProviders.ts";
import { CardGlyph } from "./CardGlyph";
import { FirstRunBack } from "./FirstRunBack";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Detected models on this computer (or on a typed server): pick one and start. */
export function FirstRunModelPicker({ cardId, flow, options, apiKey, title, body }: {
  cardId: FirstRunProviderCardId;
  flow: FirstRunFlow;
  options: LocalModelOption[];
  apiKey?: string;
  title: string;
  body?: string;
}) {
  const { copy } = flow;
  const [selectedKey, setSelectedKey] = useState(options[0]?.key ?? "");
  const selected = options.find((option) => option.key === selectedKey) ?? options[0];
  const busy = Boolean(flow.commit.pending);
  return (
    <SetupWizardContent width="wide">
      <Inline>
        <FirstRunBack label={copy.backToList} onClick={flow.backToList} />
      </Inline>
      <Inline cross="start" gap="md" wrap={false}>
        <IconTile size="md"><CardGlyph cardId={cardId} /></IconTile>
        <Stack gap="none">
          <Typo.H4 as="h1" id="first-run-models-title">{title}</Typo.H4>
          {body ? <Typo.Caption tone="secondary">{body}</Typo.Caption> : null}
        </Stack>
      </Inline>
      {options.length === 0 ? <Typo.Body tone="secondary">{copy.noModels}</Typo.Body> : (
        <ChoiceCardList aria-labelledby="first-run-models-title" role="radiogroup">
          {options.map((option) => (
            <ChoiceCard
              aria-checked={option.key === selected?.key}
              chevron={false}
              data-model-key={option.key}
              icon={<ModelLogo logo={option.logo} />}
              key={option.key}
              meta={option.sizeLabel}
              role="radio"
              selected={option.key === selected?.key}
              title={option.modelId}
              onClick={() => setSelectedKey(option.key)}
            />
          ))}
        </ChoiceCardList>
      )}
      <Stack gap="sm">
        <Button
          disabled={!selected || busy}
          size="lg"
          stretch
          type="button"
          onClick={() => selected && flow.connectLocal(cardId, selected, apiKey)}
        >
          {busy ? copy.connecting : copy.localStart}
        </Button>
        <Typo.Caption align="center" tone="tertiary">{copy.localNote}</Typo.Caption>
      </Stack>
    </SetupWizardContent>
  );
}

function ModelLogo({ logo }: { logo?: ProviderCardLogo }) {
  return logo ? <ProviderLogo name={logo} /> : <Server size="md" />;
}
