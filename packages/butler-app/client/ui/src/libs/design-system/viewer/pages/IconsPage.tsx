import { IconGallery } from "../../components/Icons/IconGallery";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";

export function IconsPage() {
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Typo.H1>Icons</Typo.H1>
        <Typo.Body>
          {'Import by name from "@/butler-ds" and size with the icon token scale (size="xs"…"2xl").'}
        </Typo.Body>
      </Stack>
      <IconGallery />
    </Stack>
  );
}
