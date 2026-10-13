# UnreadDot

## What is this component
A small accent dot (`--accent`) in an `IconSlot`: something new arrived that the user has not seen yet.

## When to use this component
A navigation row whose content changed since the user last looked (a conversation with a new reply), or a collapsed folder that holds such a row.

## Where to use this component
The trailing slot of `NavRow` and `CollapsibleNavGroup` rows, in the same column as the row's status marks (Spinner, attention glyph).

## Why to use this component
It aligns with the other status marks (first line, sidebar density) and keeps one look for "new" across the app.

## How to use this component
`<UnreadDot label="Unread" />`. Show one trailing mark at a time: attention, then working, then unread. Put the same label in the row's `ariaDescription`, because a row's own name hides the marks inside it.

## Who can use this component
Product components and blocks.

## Best practice
Clear it when the user opens the content. Do not show a count; the dot is a yes/no state.

## Wrong use cases
- Do not animate or pulse it; it is a quiet state, not an alert. Use `CircleAlert` in an `IconSlot` for something that needs action.
- Do not use it for work in progress; use `Spinner`.
- Do not put it beside the row label; it belongs in the trailing slot.

## Tags
unread, new, dot, badge, status, indicator
