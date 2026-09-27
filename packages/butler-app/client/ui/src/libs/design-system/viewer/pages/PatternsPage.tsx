import { Card } from "../../components/Card";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext } from "../../showcase";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { TokenChip } from "../foundations/TokenChip";
import { PageHeader } from "../parts";
import { PATTERNS } from "../patterns";
import { StoryCanvas } from "../StoryFrame";
import { NotFoundPage } from "./NotFoundPage";
import styles from "../DesignSystemViewer.module.css";

type AppLocale = ShowcaseRenderContext["locale"];

export function PatternsPage({ onOpen }: { onOpen: (page: string) => void; locale: AppLocale }) {
  return (
    <Stack gap="2xl" data-ds-patterns>
      <PageHeader eyebrow="Patterns" title="How the pieces behave together"
        lead="Rules that span components: surfaces, scrolling, layout, language, settings, drag and drop, and the message queue. Each pattern links the stories that implement it." />
      <div className={styles.cardGrid}>
        {PATTERNS.map((pattern) => (
          <Card interactive key={pattern.id} aria-label={pattern.title} onClick={() => onOpen(`patterns/${pattern.id}`)} data-ds-pattern-card={pattern.id}>
            <Stack gap="sm">
              <Typo.PanelTitle>{pattern.title}</Typo.PanelTitle>
              <Typo.Caption tone="secondary" lineClamp={3}>{pattern.summary}</Typo.Caption>
            </Stack>
          </Card>
        ))}
      </div>
    </Stack>
  );
}

export function PatternPage({ id, entries, locale, onOpen }: { id: string; entries: ShowcaseEntry[]; locale: AppLocale; onOpen: (page: string) => void }) {
  const pattern = PATTERNS.find((item) => item.id === id);
  if (!pattern) return <NotFoundPage id={`patterns/${id}`} onOpen={onOpen} />;
  const viewerLocale = locale === "ko-KR" ? "ko" : "en";
  return (
    <Stack gap="2xl" data-ds-pattern={pattern.id}>
      <PageHeader eyebrow="Pattern" title={pattern.title} lead={pattern.summary} />
      <Section title="Rules" titleAs="h2">
        <Stack gap="xs" as="ul">{pattern.rules.map((rule) => <li key={rule}><Typo.Body>{rule}</Typo.Body></li>)}</Stack>
      </Section>
      {pattern.demo ? <Section title="Anatomy" titleAs="h2">{pattern.demo(locale)}</Section> : null}
      <Section title="Live" titleAs="h2" description="Stories from the showcases that implement this pattern.">
        {pattern.live.map((ref) => {
          const entry = entries.find((item) => item.id === ref.entry);
          const story = entry?.stories.find((item) => item.name === ref.story);
          return story && entry ? (
            <Section key={`${ref.entry}#${ref.story}`} title={`${entry.meta.title} · ${story.name}`} data-ds-story={story.name}>
              <StoryCanvas locale={viewerLocale} story={story} />
            </Section>
          ) : null;
        })}
      </Section>
      <Section title="Tokens" titleAs="h2">
        <Stack align="row" gap="xs" wrap>{pattern.tokens.map((name) => <TokenChip key={name} name={name} onOpen={onOpen} />)}</Stack>
      </Section>
    </Stack>
  );
}
