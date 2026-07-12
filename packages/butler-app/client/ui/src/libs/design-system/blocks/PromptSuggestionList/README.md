# PromptSuggestionList

## What is this component

PromptSuggestionList is a Butler design-system block for new-chat and empty prompt surfaces. It pairs a moment label, title, optional title icon, optional description, optional low-cost fluid background, and a horizontal rail of tall tinted-glass suggestion cards.

## When to use this component

Use it when a conversation, command surface, or onboarding panel has no user content yet and should offer a small set of actionable prompts.

## Where to use this component

Use it in conversation empty states and prompt-first surfaces. Keep domain copy, data loading, title icons, and submit behavior in the product container.

## Why to use this component

It keeps empty prompt screens visually coherent: moment rhythm, title/icon alignment, card proportions, glass treatment, ordinal markers, hover motion, and horizontal rail behavior stay consistent without one-off product CSS.

At compact widths, the title icon moves into the moment row beside the three-dot marker and time. The title, description, and suggestion rail then use the full content width inside the adaptive page gutter. Expanded layouts keep the icon beside the title.

## How to use this component

Pass a `title`, optional `moment`, optional `titleIcon`, optional `description`, optional `fluidBackground`, optional `fluidPalette`, optional `fluidPaletteOptions`, optional `fluidTone`, optional `fluidVariant`, and `suggestions` with stable ids, `title`, `description`, prompt `text`, optional `meta`, and select handlers. The start surface intentionally uses ordinals instead of item icons or abstract card graphics.

## Who can use this component

Butler client containers and design-system fixtures can use this block. The block itself must stay presenter-only.

## Best practice

- Keep suggestions short and action-oriented.
- Use three to five suggestions.
- Give each card a short title plus one concise description.
- Let the rail scroll horizontally at the viewport edge instead of clipping it inside an invisible max-width container.
- Keep the rail free of edge shadows; cards carry the only tinted glass treatment.
- Keep all domain behavior in the container.
- Let the block own compact icon placement; do not reserve a product-level icon gutter.

## Wrong use cases

- Do not use it for general navigation lists; use `NavRow` or `ListRow`.
- Do not use it for alert copy; use `Notice`.
- Do not use it for empty list rows that need only one line; use `EmptyLine`.

## Tags

empty, prompt, suggestion, new-chat, onboarding
