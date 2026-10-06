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

### Decoration and edge character

`decoration` takes card art, normally `<ComposerDecoration scene="shoreline" />`.
The slot renders it as the form's first child in an `aria-hidden` layer that
fills the card (`position: absolute; inset: 0; z-index: -1`), clipped by the
card radius, with no pointer events. It paints above the glass fill and below
every editor and toolbar node. The card is `position: relative;
isolation: isolate`, so the art never escapes it. The slot adds no scrim:
readability comes from the scene's own grade, never from a layer behind the
text. TintedGlass redraws its top highlight above the art.

`ComposerDecoration` scenes carry their approved tuning, so product code only
picks a name (`COMPOSER_DECORATION_SCENES`) and passes no numbers. `shoreline`
puts the waterline 19px above the bottom edge at a fixed scale (the canvas is
at least 360px tall), grades exposure 1.22 and tones the sand highlight down by
0.06 in light mode, adds a 0.3 gradient toward the glass tint over the bottom
quarter, and draws no cloud shadows by day. Pass the user's wallpaper `motion`;
`pauseOnBattery` is on by default. It runs on the Wallpaper engine (20fps cap,
pauses offscreen, hidden and on reduced motion).

`edge` takes `{ behind, front }` for a character on the card's top edge,
normally `composerDecorationEdge("shoreline")` (a crab;
`ComposerEdgeCharacter` renders the parts). Both parts sit in zero-height
strips anchored to the form's top, not the wrap, so a `notice` above never
moves them: `behind` paints under the card (the card hides its lower 8px),
`front` over the top edge. Both are decorative and take no pointer events.

`edge.reserveTop` (px; `composerDecorationEdge` sets it from
`COMPOSER_EDGE_CHARACTER_RISE`, 26 for the crab) is how far the character
rises above the card. ComposerCard reserves it as top padding on the wrap
(`data-edge-reserve`, `--composer-edge-reserve`), so anything that measures
the wrap, such as the conversation's composer height reservation, includes the
character without its own number. A floating wrap grows upward; the card does
not move.

## Who can use this component

Agents building Butler conversation or worker input surfaces.

## Best practice

Keep file picking, model selection, permissions, and submission logic in the
container. Pass only the finished controls into the toolbar.

## Wrong use cases

Do not use this for settings forms or command input. Use `SettingsField`,
`DialogForm`, or `CommandPanel` instead.

## Tags

composer, chat, glass, input, toolbar, decoration
