import { useEffect, useState } from "react";
import { Box, Stack, Typo, type WallpaperContentRect } from "@/butler-ds";
import { useElementClientRect } from "@/hooks/useElementClientRect.ts";

export function EpicEmptyState({ title, caption, onContentRect }: {
  title: string;
  caption: string;
  onContentRect: (rect: WallpaperContentRect | undefined) => void;
}) {
  const [heading, setHeading] = useState<HTMLElement | null>(null);
  const rect = useElementClientRect(heading?.parentElement ?? null);
  useEffect(() => {
    onContentRect(rect);
    return () => onContentRect(undefined);
  }, [rect, onContentRect]);
  return <Stack fill justify="center" cross="center" data-test-class="new-chat-empty-state">
    <Box padding="xl" maxWidth="full">
      <Typo.H1 as="h2" align="center" wrap="anywhere" ref={setHeading}>{title}</Typo.H1>
      <Typo.Caption align="center" tone="secondary">{caption}</Typo.Caption>
    </Box>
  </Stack>;
}
