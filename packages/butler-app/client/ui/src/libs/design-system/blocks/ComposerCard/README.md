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

## Detached controls

The existing `ComposerCardToolbar` renders in the DS-owned slot immediately
below the card. Its order, spacer and expanded group are unchanged. Product
controls use standard `PillButton surface="glass"` triggers, including the
existing `ComposerControl` block and `SelectPillTrigger`. No decorative button
wrappers are added. The context donut retains its original button: its ring
is encapsulated in `ContextDonutButton`, which has no pill composition API.
`ComposerSendButton` and `ComposerCardCompactPreview` render in slots inside
the input card. The editor reserves room for send/stop; attachments, notice and
adjunct/question surfaces keep their existing ownership and behavior.

The **Real composer** story on this page mounts the app's `ComposerInputSurface`
(including Lexical, `ComposerToolbar` and all existing menus). Only the data and
actions are in-memory fixtures: no gateway or model calls. Use the state selector,
question/attachment/photo switches, and the viewer's width, theme and motion
controls for review. An open question uses the app's existing replacement panel;
"Later" restores the message input and controls. The plan badge still removes
plan mode; it does not acquire a new menu.

Build the portable viewer with `bun run --cwd packages/butler-app/client/ui
build:ds-site`; `dist-ds-site/index.html?page=blocks/ComposerCard&width=375&theme=dark&motion=reduced`
is the entry (serve the folder over HTTP). The existing site build emits relative
asset paths and no source maps.
