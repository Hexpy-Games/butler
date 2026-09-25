import { MetricCard } from "../../blocks/MetricCard";
import { MetricGrid } from "../../blocks/MetricGrid";
import { Notice } from "../../blocks/Notice";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";

export function OverviewPage({ entries, onOpen }: {
  entries: ShowcaseEntry[];
  onOpen: (page: string) => void;
}) {
  const components = entries.filter((entry) => entry.kind === "component").length;
  const blocks = entries.length - components;
  const showcases = entries.filter((entry) => entry.origin === "showcase").length;
  const readmes = entries.filter((entry) => entry.readme !== null).length;

  return (
    <Stack gap="2xl" data-ds-overview>
      <Stack gap="sm">
        <Typo.H1>Butler design system</Typo.H1>
        <Typo.Body>
          Browse Butler tokens, components, and blocks. Every page is a deep link: share the URL to
          reopen the same item, theme, locale, and preview width.
        </Typo.Body>
      </Stack>
      <MetricGrid columns={4}>
        <MetricCard label="Components" value={components} />
        <MetricCard label="Blocks" value={blocks} />
        <MetricCard label="Showcase files" value={`${showcases} / ${entries.length}`} />
        <MetricCard label="READMEs" value={`${readmes} / ${entries.length}`} />
      </MetricGrid>
      <Notice
        tone="info"
        title="Showcase migration in progress"
        message="Items without a co-located *.showcase.tsx still render their registry fixture as a single Default story."
      />
      <ButtonContainer size="default">
        <Button text="Foundations" variant="outline" onClick={() => onOpen("foundations")} />
        <Button text="Components" variant="outline" onClick={() => onOpen("components")} />
        <Button text="Blocks" variant="outline" onClick={() => onOpen("blocks")} />
      </ButtonContainer>
    </Stack>
  );
}
