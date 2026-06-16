# WorkActivityBlock

## What Is This Component

WorkActivityBlock presents one conversation work-progress group with a title,
optional rationale, and tool or activity rows.

## When To Use This Component

Use it for assistant work planning, toolchain progress, and collapsed history
blocks inside the conversation timeline.

## Where To Use This Component

Use in chat timeline containers that map Butler progress rows or work blocks
into display-safe titles and details.

## Why To Use This Component

It preserves readable hierarchy for work progress without letting product code
rebuild typography, spacing, or row styles per activity type.

## How To Use This Component

The product container maps domain rows into `title`, `description`, `running`,
and `tools`. The block owns the visual structure.

## Who Can Use This Component

Any Butler client agent or developer rendering conversation work state.

## Best Practice

Keep details concise and safe for display. Use regular body weight for
activity prose; use tertiary text for the body so it does not compete with the
assistant answer. Use the title slot only for the block label.
Use secondary text for work titles and the quieter work muted tone for body and
toolchain copy; work progress should sit below the assistant answer in visual
priority.
The title, description, and toolchain row start edge should align on the same
content column. Multiple toolchain rows are grouped into one capped outline
control with concise counts by tool kind. Opening the group reveals ordered
text-style tool rows; each row can expand safe detail text inline without
creating nested outline buttons. A single tool row may still use the capped
outline control directly so long commands do not stretch the whole
conversation.
Titles must wrap. Do not truncate or force a single line for work labels,
because generated work summaries can be long.
Keep completed and running work in the same timeline visual language. Do not
wrap completed work in a filled card or active background surface.
When multiple work blocks stack, the timeline rule should bridge the vertical
gap so it reads as one continuous timeline.
Do not use a decorative default icon for each work block. If a product does
not provide a meaningful activity-specific icon, the block marks the timeline
with a small dot on the line instead. Toolchain rows may still use
activity-specific icons.

## Electron App Worker Timeline Check

Use this quick path when validating worker activity through the desktop app:

1. From the repository root, install client dependencies if needed with
   `npm run app:client:install`, then open the Electron client with
   `npm run app:client`. For iterative UI work, `npm run app:client:dev` is
   the dev flow.
2. In the running app, trigger a worker-backed action from the conversation or
   resume an existing worker so the inspector has worker history to display.
3. Open the right inspector and select `Workers`. Expand `Show details` for the
   worker row. The expected evidence is a chronological work timeline rendered
   with `WorkActivityBlock` rows, including the work label, decision body,
   toolchain rows, and a running marker while the worker is active.
4. If the timeline is missing, first confirm the worker row is present and has
   detail blocks. Then check the app gateway/agent logs for worker activity
   summaries, and verify the UI mapping still passes `work_blocks` from
   `WorkersPanel` into `WorkActivityBlock`.

## Wrong Use Cases

Do not use it for generic inspector lists; use ActivityFeed or KeyValueRow. Do
not use it for settings sections; use FormSection.

## Tags

conversation, work, activity, progress, toolchain
