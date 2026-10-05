# ComposerCard

## What is this component

`ComposerCard` is the Butler chat composer surface. It owns the glass card,
textarea rhythm, adjunct panel inset, inline action, external controls slot, and
send/stop control.

The composer never folds. Use `ComposerCardInlineAction` for an editor that grows
beside send/stop, and `controls` for the always-visible glass pill row below it.
The floating bottom offset applies to the row; containerRef reserves both surfaces.

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
and menu controls. Compose `ComposerCardInlineAction` with `ComposerSendButton` as its
action; put the editor inside and attachments after it. Pass a horizontal flush
`ScrollArea` with glass pills to `controls`. `--composer-controls-inset` defaults to
zero and moves both resting pill edges symmetrically.
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
notice that must stay visible above the form. The slot sits
outside the form and participates in the floating composer height.

## Who can use this component

Agents building Butler conversation or worker input surfaces.

## Best practice

Keep file picking, model selection, permissions, and submission logic in the
container. Pass only the finished controls into the controls slot.

## Wrong use cases

Do not use this for settings forms or command input. Use `SettingsField`,
`DialogForm`, or `CommandPanel` instead.

## Tags

composer, chat, glass, input, toolbar
