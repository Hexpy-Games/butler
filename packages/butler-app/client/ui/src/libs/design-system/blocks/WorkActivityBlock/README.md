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

Tool items may supply `after` for always-visible related content at the bottom
of the group. Collapsed order is button then related content; expanded order is
button, ordered operation rows, then related content, without duplication.
Product state is injected through this slot, never read by DS.

### Live dot

`live` marks the newest activity of work that is still running: its timeline
dot fills with `--text-primary` and breathes slowly (opacity, one cycle per
`--motion-live-pulse`, 1.6s). Set it on one row only, the last. Completed work
has no live row. Reduced motion (OS or the app setting) sets
`--motion-loop-count` to 0, so the dot stays filled and still. A row with an
`icon` has no dot and ignores `live`.

### WorkActivityDisclosure

A work card whose full timeline opens in place. Collapsed, the status line
and the timeline tail form one disclosure button:

- the previous activity, one line fading toward the top (top fade: a mask from
  20% to 75% opacity, and a timeline line that rises out of nothing);
- the latest activity on the same dot and line as the expanded timeline
  (`live` pulses its dot);
- a `"+N ›"` Tag (`iconEnd` chevron) at the trailing edge with the records
  beyond the latest; with none, only the chevron.

Expanded, the tail folds away with the Collapsible exit (`--motion-exit-base`,
accelerate) while the details open (`--motion-base`, standard), so there is
only one timeline: the one inside the details. A collapse chevron fades in at
the status line's trailing edge. Collapsing reverses both. The tail's gap to
the status line folds with it, so the card never jumps.

```tsx
<WorkActivityDisclosure status="Working" latest="Compare performance · Web search"
  previous="Check prices" hiddenCount={3} live expanded={open} onToggle={toggle}
  label="Working, Compare performance · Web search, 3 earlier records"
  detailsId={id} detailsLabel="Price research details">
  <ScrollArea maxHeight="sm">{timeline}</ScrollArea>
</WorkActivityDisclosure>
```

The caller bounds the details (`ScrollArea maxHeight="sm"`, 320px with edge
fades) and passes the accessible `label`; the tail is `aria-hidden`. Tail rows
truncate to one line; timeline rows inside the details still wrap.
Touch: collapsed, the toggle is 66px tall on desktop and 74px on a phone;
expanded, an invisible strip keeps it at `--control-hit-target` (30px, 44px).

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
creating nested outline buttons. A row's chevron sits directly after its
title, never at the row's far edge. A single tool row may still use the capped
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
