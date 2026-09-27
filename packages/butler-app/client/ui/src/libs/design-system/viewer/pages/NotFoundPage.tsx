import { Notice } from "../../blocks/Notice";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";

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
