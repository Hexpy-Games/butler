import { useState } from "react";
import {
  SetupWizardStepAction,
  ChoiceCard,
  ChoiceCardList,
  ProviderLogo,
  Server,
  Typo,
} from "@/butler-ds";
import type { FirstRunProviderCardId, LocalModelOption, ProviderCardLogo } from "@/app/setupProviders.ts";
import { CardGlyph } from "./CardGlyph";
import { FirstRunStepCard } from "./FirstRunStepCard";
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
    <FirstRunStepCard flow={flow} contentKey={`models:${cardId}`} icon={<CardGlyph cardId={cardId} />} title={title}
      titleId="first-run-models-title" description={body} onBack={flow.backToList}
      footerStart={<Typo.Caption tone="tertiary">{copy.localNote}</Typo.Caption>}
      actions={<SetupWizardStepAction forward disabled={!selected || busy} onClick={() => selected && flow.connectLocal(cardId, selected, apiKey)}>
        {busy ? copy.connecting : copy.customConnect}
      </SetupWizardStepAction>}
    >
      {options.length === 0 ? <Typo.Body tone="secondary">{copy.noModels}</Typo.Body> : (
        <ChoiceCardList aria-labelledby="first-run-models-title" role="radiogroup">
          {options.map((option) => (
            <ChoiceCard
              aria-checked={option.key === selected?.key}
              chevron={false}
              state={flow.commit.connected ? "disabled" : "default"}
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
    </FirstRunStepCard>
  );
}

function ModelLogo({ logo }: { logo?: ProviderCardLogo }) {
  return logo ? <ProviderLogo name={logo} /> : <Server size="md" />;
}
