# PromptSuggestionList

## What is this component

PromptSuggestionList is a Butler design-system block for new-chat and empty prompt surfaces. It pairs a moment label, title, optional title icon, optional description, an optional `Wallpaper` behind it, and a wrapping grid of tinted-glass suggestion cards.

## When to use this component

Use it when a conversation, command surface, or onboarding panel has no user content yet and should offer a small set of actionable prompts.

## Where to use this component

Use it in conversation empty states and prompt-first surfaces. Keep domain copy, data loading, title icons, and submit behavior in the product container.

## Why to use this component

It keeps empty prompt screens visually coherent: moment rhythm, title/icon alignment, card proportions, glass treatment, ordinal markers, hover motion, and card wrapping stay consistent without one-off product CSS.

At compact widths, the title icon moves into the moment row beside the three-dot marker and time. The title, description, and suggestion cards then use the full content width inside the adaptive page gutter. Expanded layouts keep the icon beside the title.

## How to use this component

Pass a `title`, optional `moment`, optional `titleIcon`, optional `description`, optional `wallpaper` (a `WallpaperSource`; keep its identity stable), optional `wallpaperMotion` and `wallpaperPauseOnBattery` (the stored setting's motion preferences), optional `wallpaperTone` (omit it to follow the nearest theme scope, live; the wallpaper's `contentRect` is measured here: the header plus the visible cards, so modules keep the headline and cards readable), and `suggestions` with stable ids, `title`, `description`, prompt `text`, optional `meta`, and select handlers. The start surface intentionally uses ordinals instead of item icons or abstract card graphics.

External wallpaper: when one wallpaper is shared by the new chat and the conversation (mounted in `ConversationShell background`), omit `wallpaper` and pass `onContentRect`. The block then draws no wallpaper of its own and reports the same measure (the header plus the visible cards) for the shared `Wallpaper contentRect`: each new value once, and `undefined` when it unmounts. Without `wallpaper` and `onContentRect` it measures nothing, as before.

## Who can use this component

Butler client containers and design-system fixtures can use this block. The block itself must stay presenter-only.

## Best practice

- Keep suggestions short and action-oriented.
- Compose inside `ConversationShell`: its named `conversation` container drives
  compact layout from the actual panel width, not the desktop window width.
- Use three to five suggestions.
- Give each card a short title plus one concise description.
- The cards share the header's column: one row of up to four while each card keeps 160px, then two columns, then one. Every card shows whole at any width and text size (큰 글자); nothing scrolls sideways.
- Compose inside a host that scrolls vertically (`ConversationScroll` without `scrollable={false}`): wrapped cards that pass the composer scroll above it.
- Keep the card area free of edge shadows; cards carry the only tinted glass treatment.
- Keep all domain behavior in the container.
- Let the block own compact icon placement; do not reserve a product-level icon gutter.

## Wrong use cases

- Do not use it for general navigation lists; use `NavRow` or `ListRow`.
- Do not use it for alert copy; use `Notice`.
- Do not use it for empty list rows that need only one line; use `EmptyLine`.

## Tags

empty, prompt, suggestion, new-chat, onboarding
