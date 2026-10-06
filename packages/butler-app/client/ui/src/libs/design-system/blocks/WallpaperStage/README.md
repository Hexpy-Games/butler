# WallpaperStage

## What is this component
A full-viewport base surface with a `Wallpaper` backdrop and one centered
content layer above it (`--z-content`).

## When to use this component
Small desktop lifecycle windows (startup, quit) that show a card over the
user's wallpaper.

## How to use this component
```tsx
<WallpaperStage wallpaper={<Wallpaper source={source} motion="paused" />}>
  <Box surface="raised-opaque" elevation="card" border="hairline" radius="panel" padding="lg">…</Box>
</WallpaperStage>
```

The containing viewport supplies width and height. The content width leaves
two `--space-lg` insets per side (296px in a 360px window). Children own copy,
typography and actions; keep actions in a no-drag `ButtonContainer`. Put the
narrow window under `desktopViewportScope` so it keeps the desktop ramp; never
use that scope in the main window.

## Wrong use cases
- First-run setup: use `SetupWizardShell`.
- Text directly on the art: put it on an opaque content surface.

## Tags
wallpaper, layer, desktop, lifecycle
