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
