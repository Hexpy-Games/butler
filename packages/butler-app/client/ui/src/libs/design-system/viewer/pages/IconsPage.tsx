import { IconGallery } from "../../components/Icons/IconGallery";
import { Stack } from "../../components/Stack";
import { PageHeader } from "../parts";

export function IconsPage() {
  return (
    <Stack gap="2xl">
      <PageHeader eyebrow="Assets" title="Icons"
        lead={'Import by name from "@/butler-ds" and size with the icon token scale (size="xs"…"2xl"). Click an icon to copy its name.'} />
      <IconGallery />
    </Stack>
  );
}
