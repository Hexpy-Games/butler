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
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** "Pick an AI": the well-known services on top, the rest behind "more". */
export function FirstRunProviderList({ flow }: { flow: FirstRunFlow }) {
  const { copy } = flow;
  const layout = providerCardLayout({ localReachable: flow.local.reachable });
  // Run setup again opens "more" when the AI in use is there.
  const [expanded, setExpanded] = useState(() => Boolean(flow.currentCardId && layout.more.includes(flow.currentCardId)));
  return (
    <FirstRunStepCard flow={flow} contentKey="providers" title={copy.connectTitle}
      titleId="first-run-connect-title" description={copy.connectLede} onBack={flow.backFromConnect}
      footerStart={<Button
        aria-controls="first-run-more-providers" aria-expanded={expanded}
        iconEnd={expanded ? <ChevronUpIcon size="sm" /> : <ChevronDown size="sm" />}
        size="sm" text={expanded ? copy.showLess : copy.moreProviders(layout.more.length)}
        type="button" variant="link" onClick={() => setExpanded((value) => !value)}
      />}
    >
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
        {expanded ? (
          <ChoiceTileGrid data-test-class="first-run-more-providers" id="first-run-more-providers">
            {layout.more.map((cardId) => <MoreTile cardId={cardId} flow={flow} key={cardId} />)}
          </ChoiceTileGrid>
        ) : null}
      </Stack>
    </FirstRunStepCard>
  );
}

function TopCard({ cardId, flow }: { cardId: FirstRunProviderCardId; flow: FirstRunFlow }) {
  const view = providerCardView(cardId, flow, "card");
  const current = flow.currentCardId === cardId;
  const tag = current ? <Tag tone="accent">{flow.copy.tagCurrent}</Tag>
    : view.tag === "noKey" ? <Tag tone="accent">{flow.copy.tagNoKey}</Tag> : null;
  return (
    <ChoiceCard
      aria-current={current ? true : undefined}
      data-card-id={cardId}
      selected={current}
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
  const current = flow.currentCardId === cardId;
  return (
    <ChoiceTile
      aria-current={current ? true : undefined}
      selected={current}
      data-card-id={cardId}
      description={view.description}
      icon={<CardGlyph cardId={cardId} size="md" />}
      state={view.state}
      title={flow.copy.providerNames[cardId]}
      onClick={() => flow.pick(cardId)}
    />
  );
}
