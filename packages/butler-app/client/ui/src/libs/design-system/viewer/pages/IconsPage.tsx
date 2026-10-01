import { Button } from "../../components/Button";
import { IconGallery } from "../../components/Icons/IconGallery";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { PageHeader } from "../parts";
import type { ViewerLocale } from "../viewerState";

const CREDIT = {
  en: { prefix: "Icons: ", suffix: " (free set, MIT)" },
  ko: { prefix: "아이콘: ", suffix: " (무료 세트, MIT)" },
} satisfies Record<ViewerLocale, { prefix: string; suffix: string }>;

export function IconsPage({ locale }: { locale: ViewerLocale }) {
  const credit = CREDIT[locale];
  return (
    <Stack gap="2xl">
      <PageHeader eyebrow="Assets" title="Icons"
        lead={'Import by name from "@/butler-ds" and size with the icon token scale (size="xs"…"2xl"). Click an icon to copy its name.'} />
      <Stack gap="sm">
        <IconGallery />
        <Typo.Caption lang={locale}>
          {credit.prefix}
          <Button asChild variant="link">
            <a href="https://hugeicons.com" target="_blank" rel="noreferrer">Hugeicons</a>
          </Button>
          {credit.suffix}
        </Typo.Caption>
      </Stack>
    </Stack>
  );
}
