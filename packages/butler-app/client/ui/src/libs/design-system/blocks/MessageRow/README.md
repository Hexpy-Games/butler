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
`rowRef` and `offsetY` (the virtual row's translateY in px) from the
virtualizer only from the list container.

## Who can use this component

Agents building chat timelines, transcript previews, or message fixtures.

## Best practice

Keep markdown rendering, copy actions, retries, and domain records in the
container. Use `MessageFooter` for footer controls and metadata.

Assistant turns keep one body in a fixed order: activity, answer, then the
live status line. The activity block (its header and current step) sits above
the answer while it streams and after it settles; the status line (current
step label and timer) follows the answer while the turn runs. Before the first
answer text the activity row shows the activity, then the status line. Hide the
assistant footer until the turn settles, as in "Send and stream" and "Running
activity". On completion the activity header stays in place as the collapsed
summary; the current step and the status line fold away with `Collapsible`, and
the footer renders once at the end. Existing DS stream reveal, `Collapsible`
and activity motion own animations and honor reduced motion.

Assistant body sections use a column gap of `--space-lg` (16px), including the
activity, answer, status line and footer. The same gap separates the activity
from the answer and the answer from the status line, live or completed;
completion does not change the spacing token. Do not add section margins in
containers.
Use `MessageTurnGroup` for chronological transcript rows (including delegated
work): its `Stack gap="lg"` replaces individual row padding with the same 16px
gap. See "Running activity", "Completed activity" and "Completed turns".

Bubble rows (대화 / Chats only): pass `bubble` with `role="assistant"`. The
row aligns left; `MessageBubble` holds the answer text with the user bubble's
shape, padding, fill (`--user-message-bg`) and max width (`min(440px, 68%)`).
One answer is one bubble. `MessageBubbleAttachments` holds files, answer
blocks and panels under it: they align to the bubble's left edge and are no
wider than its max width. A panel that keeps its own width (the background-work
card) is a direct body child instead. The footer (copy, time) follows; the
completed status row is not shown in 대화. Work sessions keep the full-width
answer layout.

User and Butler bubbles, and the document and in-chat cards around them, use
`--radius-popover` (12px).

The optional `footer` slot renders metadata outside the message bubble. User
messages use this slot for their sent date/time and full-text copy action.
Long user text is folded by the conversation container at five rendered lines;
attachments remain outside the folded text. Neither folding nor copying changes
the stored message.

Motion: pass `entering` for a row that was just sent or just arrived (the
list decides with `useEnteringKeys`, so opening a chat or scrolling a
virtualized list never replays it); the row fades in with a
`--motion-distance-sm` rise on the `translate` property, because the
virtualizer positions rows with `transform`. `MessageStatusLabel shimmer`
sweeps a highlight across in-progress labels such as "Thinking"; reduced
motion shows static text.

## Wrong use cases

Do not use this for activity lists or inspector rows. Use `ActivityFeed`,
`WorkerActivityRow`, or `DisclosureRow` instead.

## Tags

message, chat, timeline, footer, presenter
