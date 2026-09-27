import { useState } from "react";
import {
  ChevronDown,
  ChevronUpIcon,
  ChoiceCard,
  ChoiceCardList,
  ChoiceTile,
  ChoiceTileGrid,
  Inline,
  Notice,
  RefreshCcw,
  SetupWizardContent,
  Spinner,
  Stack,
  Button,
  Globe2,
  Tag,
  Typo,
} from "@/butler-ds";
import { providerCardLayout, type FirstRunProviderCardId } from "@/app/setupProviders.ts";
import { providerCardView } from "./firstRunCardView";
import { CardGlyph } from "./CardGlyph";
import { FirstRunBack } from "./FirstRunBack";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** "Pick an AI": the well-known services on top, the rest behind "more". */
export function FirstRunProviderList({ flow }: { flow: FirstRunFlow }) {
  const { copy } = flow;
  const [expanded, setExpanded] = useState(false);
  const layout = providerCardLayout({ localReachable: flow.local.reachable });
  return (
    <SetupWizardContent width="wide">
      <Stack gap="xs">
        <Typo.H3 as="h1" id="first-run-connect-title">{copy.connectTitle}</Typo.H3>
        <Typo.Body tone="secondary">{copy.connectLede}</Typo.Body>
      </Stack>
      {flow.online ? null : <Notice tone="warning" icon={<Globe2 size="md" />} message={copy.offline} />}
      {flow.readiness.status === "preparing" ? (
        <Inline role="status">
          <Spinner size={14} />
          <Typo.Caption tone="secondary">{copy.prepWaitConnect}</Typo.Caption>
        </Inline>
      ) : null}
      <ChoiceCardList aria-labelledby="first-run-connect-title" data-test-class="first-run-top-cards">
        {layout.top.map((cardId) => <TopCard cardId={cardId} flow={flow} key={cardId} />)}
      </ChoiceCardList>
      <Stack cross="start" gap="sm">
        <Button
          aria-controls="first-run-more-providers"
          aria-expanded={expanded}
          iconEnd={expanded ? <ChevronUpIcon size="sm" /> : <ChevronDown size="sm" />}
          size="sm"
          text={expanded ? copy.showLess : copy.moreProviders(layout.more.length - (layout.localPlaceholder ? 1 : 0))}
          type="button"
          variant="link"
          onClick={() => setExpanded((value) => !value)}
        />
        {expanded ? (
          <ChoiceTileGrid data-test-class="first-run-more-providers" id="first-run-more-providers">
            {layout.more.map((cardId) => <MoreTile cardId={cardId} flow={flow} key={cardId} />)}
          </ChoiceTileGrid>
        ) : null}
      </Stack>
      <Inline>
        <FirstRunBack label={copy.back} onClick={flow.backToWelcome} />
      </Inline>
    </SetupWizardContent>
  );
}

function TopCard({ cardId, flow }: { cardId: FirstRunProviderCardId; flow: FirstRunFlow }) {
  const view = providerCardView(cardId, flow, "card");
  const tag = view.tag === "noKey" ? <Tag tone="accent">{flow.copy.tagNoKey}</Tag>
    : view.tag === "local" ? <Tag tone="success">{flow.copy.tagLocal}</Tag> : null;
  return (
    <ChoiceCard
      data-card-id={cardId}
      description={view.description}
      icon={<CardGlyph cardId={cardId} />}
      state={view.state}
      tag={tag}
      title={flow.copy.providerNames[cardId]}
      onClick={() => flow.pick(cardId)}
    />
  );
}

function MoreTile({ cardId, flow }: { cardId: FirstRunProviderCardId; flow: FirstRunFlow }) {
  const view = providerCardView(cardId, flow, "tile");
  const placeholder = cardId === "local";
  return (
    <ChoiceTile
      aria-label={placeholder ? `${flow.copy.providerNames.local}. ${flow.copy.localMissing}. ${flow.copy.rescan}` : undefined}
      cornerIcon={placeholder && view.state !== "loading" ? <RefreshCcw size="xs" /> : undefined}
      data-card-id={cardId}
      description={view.description}
      icon={<CardGlyph cardId={cardId} size="md" />}
      placeholder={placeholder}
      state={view.state}
      title={flow.copy.providerNames[cardId]}
      onClick={() => (placeholder ? flow.local.rescan() : flow.pick(cardId))}
    />
  );
}
