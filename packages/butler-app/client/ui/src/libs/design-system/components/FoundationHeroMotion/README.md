# FoundationHeroMotion

`FoundationHeroMotion` is the motion graphic at the head of each Foundations
chapter in the DS Viewer. Each variant expresses its foundation with that
foundation's own live tokens, so a theme, density or font change shows up in
the hero too.

## Use

```tsx
import { FoundationHeroMotion } from "@/butler-ds";

<FoundationHeroMotion variant="motion" />
<FoundationHeroMotion variant="color" still />
```

`variant` is a Foundations chapter id (`FOUNDATION_HERO_VARIANTS`); `still`
shows the poster frame whatever the motion setting. The stage fills its
column at 8:5, up to 17rem tall, and clamps its drawing to its own size
(container units), so it fits from a 343px column up. `typography` is a
feature hero: 16:9 up to 36rem tall, portrait (19:32) under a 45rem column.

| Variant | Chapter | What moves |
| --- | --- | --- |
| `color` | 01 Color | Role swatches step from a light pane into a dark pane; the same strip is drawn in both theme scopes, so each role recolors exactly at the seam. |
| `typography` | 02 Typography | From token to product (64 beats): "Aa가" sweeps the weight axis onto the four weight tokens and splits Latin/Hangul; it shrinks into the H2 rung of a role ladder the camera lays down in 3D (line boxes show leading, MetricValue digits roll on tabular numerals); each rung's text then flies into real DS components (SettingsHeader/SettingsField, MessageRow, MetricCard, ComposerCard) while the camera dollies panel to panel, and settles on the poster: tokens beside the assembled product. |
| `spacing` | 03 Spacing | A 3x3 field breathes through `--space-xs` … `--space-4xl` and back. |
| `sizing` | 04 Sizing | A field, icon button and primary button grow through `--control-height-xs/sm/md/lg` together. |
| `radius` | 05 Radius and elevation | One surface lifts through the shadow levels while its corners grow control → panel → popover → composer. |
| `iconography` | 06 Iconography | Three glyphs snap through the six `--icon-size-*` steps on their size boxes (shown 2x). |
| `focus` | 07 Focus ring | The one `--focus-ring` moves through the tab order: field, button, switch, checkbox. |
| `motion` | 08 Motion | Each `--motion-ease-*` token plots itself: the dot runs on the token and a sliding window reveals the curve behind it. |
| `z-index` | 09 Layers | The composed screen tilts into an exploded view of its layers (page, drawer, dialog, popover) and settles back. |
| `layout` | 10 Layout and platform | Six tiles reflow as the frame narrows from three columns to one and back. |

## Motion and performance

- CSS animations of `transform` and `opacity` only: compositor work, no frame
  loop, no canvas. Timing is multiples of `--motion-deliberate`; moves ease
  on `--motion-ease-emphasized`, fades on `--motion-ease-standard`, and the
  Motion plot runs each easing token as its own timing function.
- Easing is set per element (it applies to every keyframe segment); `var()`
  inside `@keyframes` is not honored for `animation-timing-function`.
- Heroes that take turns (slot sequences) share one cycle per hero and are
  offset by `animation-delay`, so pausing keeps them in step.
- Long sequences (Typography) are authored in `heroTimeline.ts`: tracks of
  poses at beat marks, compiled once per layout into plain CSS `@keyframes`
  with per-segment easing read from the `--motion-ease-*` tokens (which
  `var()` cannot do inside keyframes). Positions come from measuring the
  poster layout, so the same choreography fits the wide and tall canvases,
  every theme and both languages. The canvas is laid out at 2x (`zoom`) and
  drawn at half scale so camera push-ins stay sharp.
- One shared `IntersectionObserver` and one `visibilitychange` listener serve
  every hero: offscreen or in a hidden tab the loops hold their frame
  (`data-hero-state="paused"`).
- Reduced motion (OS setting or the DS `data-motion="reduced"` scope) shows
  the still poster with no animation (`data-hero-state="still"`).
- `bun run app:motion:trace -- --only=heroes` measures every hero (frame
  rate, main-thread cost per frame, long tasks, paused and still states);
  add `--video` for one recorded loop of each hero in light and dark.

## Where and why

The DS Viewer's `ChapterHeader` renders it for every chapter: beside the
title block when the header is at least 52rem wide, under it otherwise;
Typography's feature hero always spans the column under a compact title
block. It is decorative (`aria-hidden`, and `inert` where it renders real
controls); the chapter title and lead carry the meaning. Only the
Typography hero sets text: sample copy in the viewer's language (`lang`).

Tags: foundations, hero, motion, guidebook, tokens, illustration, loop
