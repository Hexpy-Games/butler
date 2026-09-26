import { EmptyLine } from "../../blocks/EmptyLine";
import { NavRow } from "../../blocks/NavRow";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { DoDontSection, NotesSection, RecipesSection, TokensSection, UsageSection } from "../item/GuidanceSections";
import { MarkdownGuide } from "../MarkdownGuide";
import { CodeSample, PageHeader } from "../parts";
import { StatesMatrix } from "../states/StatesMatrix";
import { StoryFrames } from "../StoryFrame";
import type { ResolvedTheme } from "../useViewerTheme";
import type { ViewerState } from "../viewerState";
import styles from "../DesignSystemViewer.module.css";

function Toc({ items, onOpen, pageId }: { items: Array<[string, string]>; onOpen: (page: string) => void; pageId: string }) {
  return (
    <nav aria-label="On this page" className={styles.toc}>
      <Stack gap="xs">
        <Typo.SectionTitle>On this page</Typo.SectionTitle>
        {items.map(([id, label]) => <NavRow density="compact" key={id} label={label} onClick={() => onOpen(`${pageId}#${id}`)} />)}
      </Stack>
    </nav>
  );
}

export function ItemPage({ entry, entries, state, themes, onOpen }: {
  entry: ShowcaseEntry;
  entries: ShowcaseEntry[];
  state: ViewerState;
  themes: ResolvedTheme[];
  onOpen: (page: string) => void;
}) {
  const guidance = entry.guidance;
  const toc: Array<[string, string]> = [
    ["examples", "Examples"],
    ...(entry.stateMatrix ? [["states", "States"] as [string, string]] : []),
    ...(guidance ? [["usage", "When to use"], ["do-and-dont", "Do and don't"], ["recipes", "Recipes"],
      ["content-and-accessibility", "Content and a11y"], ["tokens", "Tokens"]] as Array<[string, string]> : []),
    ["guidance", "README"],
  ];
  return (
    <div className={styles.itemLayout}>
      <Stack gap="2xl" data-ds-component={entry.name} data-ds-detail={entry.name}>
        <PageHeader eyebrow={`${entry.kind === "component" ? "Component" : "Block"} · ${entry.meta.category}`} title={entry.meta.title}
          lead={guidance?.purpose}>
          <Stack align="row" gap="xs" wrap>
            {entry.meta.status ? <Tag tone={entry.meta.status === "stable" ? "success" : "warning"}>{entry.meta.status}</Tag> : null}
            {(entry.meta.tags ?? []).map((tag) => <Tag key={tag}>{tag}</Tag>)}
          </Stack>
          <div data-ds-import><CodeSample code={`import { ${entry.name} } from "@/butler-ds";`} /></div>
          <Typo.Caption tone="tertiary">{entry.sourcePath}</Typo.Caption>
        </PageHeader>
        <Section id="examples" title="Examples" titleAs="h2" data-ds-examples={entry.name}>
          {entry.stories.map((story) => (
            <Section data-ds-story={story.name} key={`${entry.id}#${story.name}`} title={story.name}
              description={story.states?.length ? `States: ${story.states.join(", ")}` : undefined}>
              <StoryFrames locale={state.locale} story={story} themes={themes} width={state.width} />
            </Section>
          ))}
        </Section>
        {entry.stateMatrix ? (
          <Section id="states" title="States" titleAs="h2" description="Forced with data-ds-force-state: hover, focus-visible and active are simulated; the rest are real props.">
            {themes.map((theme) => <StatesMatrix key={theme} locale={state.locale} matrix={entry.stateMatrix!} theme={theme} />)}
          </Section>
        ) : null}
        {guidance ? (
          <>
            <UsageSection entries={entries} guidance={guidance} onOpen={onOpen} />
            <DoDontSection guidance={guidance} locale={state.locale} />
            <RecipesSection entry={entry} locale={state.locale} />
            <NotesSection guidance={guidance} />
            <TokensSection guidance={guidance} onOpen={onOpen} />
          </>
        ) : null}
        <Section id="guidance" title="Guidance" titleAs="h2">
          {entry.readme ? <MarkdownGuide markdown={entry.readme} /> : <EmptyLine message="No README yet." />}
        </Section>
      </Stack>
      <Toc items={toc} onOpen={onOpen} pageId={entry.id} />
    </div>
  );
}
