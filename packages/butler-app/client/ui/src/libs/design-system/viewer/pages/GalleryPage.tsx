import { EmptyLine } from "../../blocks/EmptyLine";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseEntry } from "../../showcase/collectShowcaseEntries";
import { StoryCanvas } from "../StoryFrame";
import { groupEntries, type GallerySection } from "../viewerNavigation";
import type { ViewerLocale } from "../viewerState";
import styles from "../DesignSystemViewer.module.css";

function GalleryCard({ entry, locale, onOpen }: {
  entry: ShowcaseEntry;
  locale: ViewerLocale;
  onOpen: (page: string) => void;
}) {
  const [story] = entry.stories;
  return (
    <div className={styles.card} data-ds-component={entry.name} data-ds-item={entry.id}>
      <Section
        actions={<Button size="sm" text="Open details" variant="outline" onClick={() => onOpen(entry.id)} />}
        description={<Typo.Code>{entry.id}</Typo.Code>}
        title={entry.meta.title}
      >
        {story ? <StoryCanvas story={story} locale={locale} /> : <EmptyLine message="No showcase yet." />}
      </Section>
    </div>
  );
}

export function GalleryPage({ entries, section, locale, onOpen }: {
  entries: ShowcaseEntry[];
  section: GallerySection;
  locale: ViewerLocale;
  onOpen: (page: string) => void;
}) {
  const groups = groupEntries(entries, section === "components" ? "component" : "block");
  const count = groups.reduce((total, group) => total + group.entries.length, 0);
  return (
    <Stack gap="2xl" data-ds-gallery={section}>
      <Stack gap="sm">
        <Typo.H1>{section === "components" ? "Components" : "Blocks"}</Typo.H1>
        <Typo.Body>{`${count} ${section}, grouped by category. Each card renders the first story.`}</Typo.Body>
      </Stack>
      {groups.map((group) => (
        <Section key={group.category} title={group.category} titleAs="h2">
          <div className={styles.gallery}>
            {group.entries.map((entry) => (
              <GalleryCard entry={entry} key={entry.id} locale={locale} onOpen={onOpen} />
            ))}
          </div>
        </Section>
      ))}
    </Stack>
  );
}
