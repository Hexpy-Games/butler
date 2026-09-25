import { EmptyLine } from "../../blocks/EmptyLine";
import { Notice } from "../../blocks/Notice";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { PlaceholderSection } from "../viewerNavigation";

const COPY: Record<PlaceholderSection, { title: string; message: string }> = {
  patterns: { title: "Patterns", message: "Composition patterns will be documented here." },
};

export function PlaceholderPage({ section }: { section: PlaceholderSection }) {
  const copy = COPY[section];
  return (
    <Stack gap="lg" data-ds-placeholder={section}>
      <Typo.H1>{copy.title}</Typo.H1>
      <EmptyLine message={copy.message} />
    </Stack>
  );
}

export function NotFoundPage({ id, onOpen }: { id: string; onOpen: (page: string) => void }) {
  return (
    <Stack gap="lg" data-ds-not-found={id}>
      <Typo.H1>Not found</Typo.H1>
      <Notice
        tone="warning"
        message={`No design-system page matches "${id}".`}
        action={<Button size="sm" text="Back to overview" variant="outline" onClick={() => onOpen("overview")} />}
      />
    </Stack>
  );
}
