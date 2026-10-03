# ComposerCard

## What is this component

`ComposerCard` is the Butler chat composer surface. It owns the glass card,
textarea rhythm, adjunct panel inset, toolbar row, plan toggle alignment, and
send/stop control.

On compact screens it also owns idle and engaged presentation. Idle keeps one
line containing attachment, ellipsized draft or placeholder, and send/stop.
Focus or protected content expands the same form without replacing draft state.

## When to use this component

Use it when a chat or worker surface needs message input with Butler composer
controls.

## Where to use this component

Use it near the bottom of a conversation viewport. It is not a generic form
card.

## Why to use this component

The composer is a high-visibility glass component. Centralizing it prevents
agents from recreating subtly different textarea, toolbar, and send-button
styles. It also keeps every direct composer section on one inner padding rhythm.

## How to use this component

Product containers provide draft state, submit handlers, attachment actions,
and menu controls. Compose `ComposerCardTextarea`, `ComposerCardToolbar`,
`ComposerPlanToggle`, and `ComposerSendButton`.
Set `ComposerSendButton busy` for temporary unavailability: it becomes a disabled
non-submit control with the official DS `Spinner`. Supply a localized accessible
label and title; keep it visible even in compact mode. Reduced motion stops rotation.
Set `ComposerSendButton disabledReason` when sending is blocked for a reason
the user can fix (an attached image the model does not accept, or whose image
support is unknown): the button is an `aria-disabled` non-submit control whose tooltip names the reason in a few
words. Capability feedback copy is terse and non-intrusive: the disabled state plus a few-word tooltip, and at most a brief transient toast for a refused drop or paste. No banners, inline paragraphs, persistent notices, or why/how explanations.

For inline references, use `ComposerCardEditor` with `ComposerCardEditable`
(a slot for the editor's contenteditable) and `ComposerCardPlaceholder`.
These reuse the same padding, eight-line maximum, typography and toolbar.
The DS owns appearance only; the product owns Lexical and serialization.

Plan decisions reuse the product Composer textarea and toolbar. Do not add a
second input card or nest another form inside `ComposerCard`.

Set `dropActive` while a file drag is over the card. Product containers own the
drag event handling and upload action; the card only provides visual drop
feedback.

Use the optional `notice` slot for a non-blocking dependency or capability
notice that must stay visible while the form itself is compact. The slot sits
outside the collapsible form and participates in the floating composer height.

## Who can use this component

Agents building Butler conversation or worker input surfaces.

## Best practice

Keep file picking, model selection, permissions, and submission logic in the
container. Pass only the finished controls into the toolbar.

## Wrong use cases

Do not use this for settings forms or command input. Use `SettingsField`,
`DialogForm`, or `CommandPanel` instead.

## Tags

composer, chat, glass, input, toolbar

## Separated controls

One neutral form owns two TintedGlass surfaces. Pass the editor/compact preview
as children, the always-visible controls as `controls`, and question/decision
content as `panel` (above the input). Do not put a toolbar in children.
The gap is 8px. Desktop controls hug their content, inset with the editor text;
narrow containers use the full available inset and 44px touch targets. There
is one layout; no legacy-layout preference.

`ComposerCardToolbar` orders `leading`, `secondary`, children, More, `trailing`.
Use leading for attachment/access, children for model, trailing for send/stop.
Secondary controls (workspace, Plan, context) move together into one Popover
at container widths ≤520px. This is a labelled group with ordinary Tab order.
The Popover holds the same form controls, never action-menu substitutes or
hidden focusable copies. Keep selection state in the container across moves.
Only ResizeObserver handles placement; input events do not measure layout.

The viewer's first **Interactive composer** story is the offline owner review:
state, 375px frame, theme, photo and reduced-motion switches; editable multiline
text, selectors, attachment removal and simulated send/stop. Entry:
`index.html?page=blocks/ComposerCard&theme=light&locale=en` in `dist-ds-site`.
Build with `bun run --cwd packages/butler-app/client/ui build:ds-site`; serve the
folder on any static host, including a subfolder. Assets use relative paths;
there is no gateway, provider call or source map. Native Korean IME is available
for the owner's physical-keyboard walkthrough; synthetic smoke input does not
certify an OS candidate window.


For a pending panel, `ComposerCardExpandedBody inactive` keeps a folded editor
mounted but inert, so Tab reaches the compact preview rather than hidden inputs.
Keep `expanded` true while the editor is focused or composing when a panel arrives.
The caller can then restore message mode explicitly from the compact preview.
Omit `secondary` when no secondary control applies; More is never an empty menu.
