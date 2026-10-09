import { appCopy, useAppLocale } from "@/app/copy";
import { EmptyLine, Library, Stack } from "@/butler-ds";

export function LibraryPage() {
  useAppLocale();
  return <Stack fill justify="center" cross="center" gap="md" data-test-class="library-page">
    <Library size="md" />
    <EmptyLine message={appCopy.browser.library} />
  </Stack>;
}
