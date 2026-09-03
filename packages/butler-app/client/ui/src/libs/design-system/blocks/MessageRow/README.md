# MessageRow

## What is this component

`MessageRow` is the presenter for chat timeline rows. It owns assistant/user
grid layout, message body sizing, pending/failed visual states, and footer
alignment.

## When to use this component

Use it for every Butler conversation timeline row, including assistant output,
user messages, system events, and active turn activity.

## Where to use this component

Use it inside a conversation message list. The container still owns message
records, copy actions, virtualization, and retry logic.

## Why to use this component

It prevents each message container from recreating row grids, body width rules,
and footer controls with ad hoc CSS.

## How to use this component

Pass `role`, optional `status`, optional `avatar`, and rendered body content.
Pass `index` when tests or diagnostics need a stable row order marker. Pass
`rowRef` and `style` from the virtualizer only from the list container.

## Who can use this component

Agents building chat timelines, transcript previews, or message fixtures.

## Best practice

Keep markdown rendering, copy actions, retries, and domain records in the
container. Use `MessageFooter` for footer controls and metadata.

The optional `footer` slot renders metadata outside the message bubble. User
messages use this slot for their sent date/time and full-text copy action.
Long user text is folded by the conversation container at five rendered lines;
attachments remain outside the folded text. Neither folding nor copying changes
the stored message.

## Wrong use cases

Do not use this for activity lists or inspector rows. Use `ActivityFeed`,
`WorkerActivityRow`, or `DisclosureRow` instead.

## Tags

message, chat, timeline, footer, presenter
