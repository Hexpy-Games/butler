# Engine changes (branch ui/hero-v4-engine)

Base: origin/ui/foundations-heroes-v2 @ aff9fc37b. Paths are under
`packages/butler-app/client/ui/src/libs/design-system/components/FoundationHeroMotion/heroes/`.

## Intro exit (hard rule 1)
- `shared/Intro.tsx`: `INTRO.exit = 6.8` (new), `introCamera(camera: Key[]): Key[]` (new).
  Both engines now pass every chapter's prelude camera through it
  (`shared/timeline.ts`, `scene/sceneTimeline.ts`): hold on the intro until
  `INTRO.exit`, then one `TRANSITION` glide, flat, to the chapter's pose at
  `INTRO.exit + TRANSITION`. `rx/ry/rz` are stripped from that glide. Keys
  after it are untouched. Chapters need no change if they already leave at 6.8.

## Finale packing, no tiles (hard rule 2)
- `shared/pack.ts`: `Pack` is now `{ scale, slots, natural }`, where `slots` holds painted boxes;
  `tiles` is gone. `PackItem` is `{ id, w, h, dx, dy, cw }`.
  `packPoster(items, columns?)` stacks the items in columns, each at its measured painted size.
  Gaps open up to 3 gutters, and the rest is centred. New `ChapterFinale` type.
- `shared/types.ts`: `ChapterSpec.finale?: { columns?: string[][]; tall?: "poster" | "product" }` (new, optional).
- `shared/ChapterHero.tsx`: the `data-t="tile-*"` spans are removed. Each item is laid out at
  its poster width (plus 2px slack) and placed so that its painted box sits on its slot.
- `shared/gather.ts`: `tileTracks` is removed.
- `shared/ChapterHero.module.css`: the `.tile` rule and `--natural-w` are removed.
- `scene/SceneHero.module.css`: `.tile` no longer draws a border, fill, radius or padding,
  and no longer sets `overflow: hidden`.
- `scene/SceneHero.module.css`: tile content is set to `place-items: center start`, so the titles in a column share one inset.
- `FoundationHeroMotion.module.css`: a feature stage no longer has a frame. It sets `background: transparent` and `border-radius: 0`,
  so the hero sits straight on the page. Small, non-feature stages keep their card.
- `scene/SceneHero.tsx`: each tile's child is zoomed from its real size (overflow included)
  to fill 94% of its slot, zooming down as well as up, so nothing clips.

## Labels never break inside a token (hard rule 4)
- `shared/fitLabels.ts` (new): `fitLabels(root)`. Mark a group with `data-fit` and its labels with
  `data-fit-label`, and set the labels to `white-space: nowrap` with
  `font-size: calc(<size> * var(--label-fit, 1))`. Both engines call it before measuring.

## Rebase notes for chapter branches
- Delete any use of `tileTracks`, `pack.tiles`, `c.tile`, or `data-t="tile-*"`.
- Don't rely on the tile card's padding. Size the grid areas from the content.
- Set chapter token labels to nowrap: `data-fit` / `data-fit-label`.
