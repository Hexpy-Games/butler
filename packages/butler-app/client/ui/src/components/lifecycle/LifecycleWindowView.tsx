import { Box, WallpaperStage, Button, ButtonContainer, ButlerThinkingMark, desktopViewportScope, RollingStatusLine, RollingSwap, Stack, Typo, Wallpaper } from "@/butler-ds";

/** Every slot is captured once; the static controller owns visibility and final localized copy. */
export function LifecycleWindowView() {
  return (
    <Stack {...desktopViewportScope} gap="none" fill windowDrag="drag">
      <WallpaperStage wallpaper={<Wallpaper source={{ kind: "live", module: "butler.bloom" }} motion="paused" />}>
            <Box surface="raised-opaque" elevation="card" border="hairline" radius="panel" padding="lg">
              <Stack gap="md" cross="center">
                <ButlerThinkingMark size="3xl" state="idle" theme="light" data-test-class="lifecycle-mark" />
                <Stack gap="xs" cross="center">
                  <Typo.AppTitle tone="primary" align="center" data-slot="title">Butler</Typo.AppTitle>
                  <RollingStatusLine role="status" aria-live="polite">
                    <RollingSwap itemKey="prepare"><Typo.Body tone="secondary" align="center" data-slot="line">Getting ready…</Typo.Body></RollingSwap>
                  </RollingStatusLine>
                  <Typo.Body tone="secondary" align="center" data-slot="detail">Couldn't load your data.</Typo.Body>
                  <Typo.Caption tone="tertiary" align="center" data-slot="caption">Taking longer than usual.</Typo.Caption>
                </Stack>
                <ButtonContainer size="sm" justify="center" windowDrag="no-drag" data-slot="actions">
                  <Button size="sm" variant="secondary" data-slot="secondary">Open log</Button>
                  <Button size="sm" data-slot="primary">Try again</Button>
                  <Button size="sm" variant="destructive" data-slot="destructive">Force quit</Button>
                </ButtonContainer>
              </Stack>
            </Box>
      </WallpaperStage>
    </Stack>
  );
}
