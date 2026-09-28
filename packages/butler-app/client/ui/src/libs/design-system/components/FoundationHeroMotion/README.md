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
shows the poster frame whatever the motion setting. Every chapter hero is a
feature hero: the full column at 16:9 (up to 36rem tall), portrait (19:32)
under a 45rem column, drawn on a 1040x585 (or 380x640) canvas that covers
the stage.

Each chapter tells its own story in a prelude (its own scenes, one camera
move at a time, down or right), then builds real DS components one at a
time (blueprint, surface, content, badges with leaders naming their
tokens), then zooms out to the poster: the chapter's token field beside the
components. The shared engine is `heroes/shared/` (`ChapterHero`,
`timeline.ts`, `scene.ts`); each chapter folder holds its copy (en/ko), its
scenes, its prelude choreography and its builds.

| Variant | Chapter | Story |
| --- | --- | --- |
| `color` | 01 Color | Intent; circular stickers land on an isometric grid in a diagonal ripple and take their token names; a line wipes the whole frame into the other theme and back; components by topic, outlined then filled color by color. |
| `typography` | 02 Typography | "A가" in a type designer's working view, moved through the weight axis; it becomes the H2 of the role list; four components are built line by line under badges naming each line's token. |
| `spacing` | 03 Spacing | The space staircase on a 4px grid; a wireframe measured gap by gap; insets, stacks, inline rows and sections. |
| `sizing` | 04 Sizing | Four rails at the control heights with real controls on them; hit areas bloom and grow for touch; the app frame's chrome measured. |
| `radius` | 05 Radius and elevation | One shape morphs through the radii and nests; surfaces lift through the shadow levels; components with their corners and shadows. |
| `iconography` | 06 Iconography | A glyph draws on its keyline grid; the size ladder in three tones; icons in real controls. |
| `focus` | 07 Focus ring | The ring travels the tab order (tab, then shift-tab); a close-up measures it; one ring on every control. |
| `motion` | 08 Motion | Each easing token plots itself; durations race; reduced motion swaps moves for fades; components replay their own motion. |
| `z-index` | 09 Layers | The z tokens drop in as numbered sheets; a screen builds layer by layer and a slider spreads the layers apart, flat, and closes them; sticky header, drawer, dialog and tooltip with their z badges. |
| `layout` | 10 Layout and platform | The page frame draws (titlebar, max width, columns and gutter, safe areas); a handle drags it 1280 → 1023 → 640 → 375 through expanded, medium and compact (responsive.ts), the sidebar becoming a drawer; whole screens build at a lower zoom. |

## Motion and performance

- CSS animations of `transform` and `opacity` only: compositor work, no frame
  loop, no canvas. Timing is multiples of `--motion-deliberate`; moves ease
  on `--motion-ease-emphasized`, fades on `--motion-ease-standard`, and the
  Motion plot runs each easing token as its own timing function.
- Easing is set per element (it applies to every keyframe segment); `var()`
  inside `@keyframes` is not honored for `animation-timing-function`.
- Every hero is authored in `heroTimeline.ts`: tracks of
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
Chapter heroes always span the column under a compact title block. It is decorative (`aria-hidden`, and `inert` where it renders real
controls); the chapter title and lead carry the meaning. Sample
copy follows the viewer's language (`lang`).

Tags: foundations, hero, motion, guidebook, tokens, illustration, loop
