import { EmptyLine } from "../../blocks/EmptyLine";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { MarkdownGuide } from "../MarkdownGuide";
import { StoryFrames } from "../StoryFrame";
import type { ResolvedTheme } from "../useViewerTheme";
import type { ViewerState } from "../viewerState";

function ItemHeader({ entry }: { entry: ShowcaseEntry }) {
  const kindLabel = entry.kind === "component" ? "Components" : "Blocks";
  return (
    <Stack gap="md">
      <Typo.Caption>{`${kindLabel} / ${entry.meta.category}`}</Typo.Caption>
      <Typo.H1>{entry.meta.title}</Typo.H1>
      <Stack align="row" gap="xs" wrap>
        {entry.meta.status ? <Tag>{entry.meta.status}</Tag> : null}
        {entry.origin === "registry" ? <Tag>registry fixture</Tag> : null}
        {(entry.meta.tags ?? []).map((tag) => <Tag key={tag}>{tag}</Tag>)}
      </Stack>
      <Stack gap="xs">
        <Typo.Code data-ds-import>{`import { ${entry.name} } from "@/butler-ds";`}</Typo.Code>
        <Typo.Caption>{entry.sourcePath}</Typo.Caption>
      </Stack>
    </Stack>
  );
}

export function ItemPage({ entry, state, themes }: {
  entry: ShowcaseEntry;
  state: ViewerState;
  themes: ResolvedTheme[];
}) {
  return (
    <Stack gap="2xl" data-ds-component={entry.name} data-ds-detail={entry.name}>
      <ItemHeader entry={entry} />
      <Section title="Examples" titleAs="h2" data-ds-examples={entry.name}>
        {entry.stories.length === 0 ? <EmptyLine message="No showcase yet." /> : null}
        {entry.stories.map((story) => (
          <Section data-ds-story={story.name} key={`${entry.id}#${story.name}`} title={story.name}
            description={story.states?.length ? `States: ${story.states.join(", ")}` : undefined}>
            <StoryFrames locale={state.locale} story={story} themes={themes} width={state.width} />
          </Section>
        ))}
      </Section>
      <Section title="Guidance" titleAs="h2">
        {entry.readme ? <MarkdownGuide markdown={entry.readme} /> : <EmptyLine message="No README yet." />}
      </Section>
    </Stack>
  );
}
