# QueuedMessage

## What is this component
A pending user-side message in the conversation: a status label (clock icon,
"Queued · 2 of 3"), a bubble with a dashed hairline outline and a subdued
fill, and a controls row with an optional "Send now" text button plus edit
and delete icon buttons.

## When to use this component
Use it for follow-ups the user sent while a turn is still running, and for
queued sends that failed, until they are delivered or removed.

## Where to use this component
Use it at the end of the conversation message list, after the active turn
activity row, positioned by the list virtualizer (`offsetY`, `rowRef`).

## Why to use this component
The queue lives where the message will land, so the composer stays compact
and the delivered message resolves in place (MessageRow
`entering="delivered"` fades the dashed outline into the solid bubble).

## How to use this component
Pass the formatted text as children, the status label, the tone
(`queued`, `sending` or `failed`), copy for the controls, and the handlers.
Pass `onSendNow` only for the message that would be sent next. `entering`
marks a just-queued row: its bubble flies in from the composer when a send
origin was recorded (`recordSendOrigin`), otherwise the row fades in with a
small rise; reduced motion keeps only the fade.

## Who can use this component
Conversation containers that own the queue records and actions.

## Best practice
Keep queue semantics (ordering, which actions are allowed, copy) in the
caller. The block is presenter-only and never reads app state.

## Wrong use cases
Do not use it for sent messages (`MessageRow` with `role="user"`) or for
composer drafts (`ComposerCard`).

## Accessibility
Every control has an accessible name; icon buttons show tooltips and "Send
now" explains in its tooltip that it stops the current response. The row is
an `article` with an optional `aria-label`.

## Responsive behavior
The bubble keeps the user bubble width rule (`min(440px, 68%)`) and wraps
long text; the controls row stays right-aligned at 320px.

## Tags
conversation, queue, pending, message, follow-up, motion
