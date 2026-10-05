# New-chat visual reference

`reference.json` was captured from the full UI built at tag
`v0.1.0-preview.6` (`7961a7f0fff72cebe50025111957aef5c302655b`).
It is a rendered browser reference, not a source-string assertion.

Run `bun run app:newchat:smoke` with isolated `HOME` / `BUTLER_DATA`.
The native gateway uses isolated data and completed onboarding with a stub
provider. The published preview.7 macOS Agent served all three UI builds
for the original comparison; the gateway was kept constant to isolate UI changes.
The only intercepted field is the briefing clock label (`오후 3:25`).
The browser clock, timezone, reduced motion, viewport height (900), and paused
`butler.shoreline` scene are fixed. No content is omitted.

The eight cases cover 1280 / 375, light / dark, coastal / no wallpaper.
Each compares the hero and all four complete cards, plus the first card's
hover/focus state: descendant structure, text, computed backgrounds (including
pseudo elements), glass tint/filter, typography and borders must match exactly;
positions/sizes may differ by at most 1 CSS pixel. Class hashes and asset URLs
are excluded because builds can rename them. A composited coastal screenshot
must contain the scene's varied pixels; `none` must remove or hide/release its
wallpaper canvas. Screenshots and `report.json` go to `.tmp/newchat-regression/fix`.
`BUTLER_SMOKE_UI_ROOT` and `BUTLER_SMOKE_SCREENSHOTS` select a historical build
and artifact directory without changing assertions. The smoke has no baseline
update mode: do not regenerate this reference from the current build.

## Regression origin

The tag-range log has exactly one change to these shared new-chat surfaces:
`83ac46d41d55f9bccec2656907b8b06942a775db`, merged into preview.7 by
`124e4dadf` (PR #469). In that commit:

- `PromptSuggestionList.tsx:81,127` wrapped the hero in `Card` / `Box` / `Stack`.
- `PromptSuggestionList.module.css:42-49` added the opaque, negatively margined
  header surface, extending into the hanging mark's gutter.
- `PromptSuggestionList.module.css:191,197,212` replaced the existing translucent
  normal/hover glass backgrounds and tint with `--color-surface-raised-opaque`.

PR #469 explicitly calls this a captain change to “opaque DS welcome/suggestion
surfaces”; this was an intentional surface change applied globally through a
shared DS block, not a wallpaper/theme or OS leak. The commit did not explain
the readability rationale. The independent onboarding entry (`38e37dbab`),
activity layout and release/native-host changes remain intact. ConversationShell,
Wallpaper, TintedGlass and theme tokens are unchanged between these tags.

Historical screenshots use the following filenames under each of
`.tmp/newchat-regression/{preview6,preview7,fix}`:

- `1280-light-coastal.png`, `1280-light-none.png`
- `1280-dark-coastal.png`, `1280-dark-none.png`
- `375-light-coastal.png`, `375-light-none.png`
- `375-dark-coastal.png`, `375-dark-none.png`
