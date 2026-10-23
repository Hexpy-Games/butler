# UsageBars

## What is this component
Stacked usage columns over time: one column per time bucket, its segments
stacked bottom-up in `series` order with no gaps: type is shown by color
only. A segment can carry a subtask part, drawn hatched on top of it in the
same color. Two sizes share one look:

| size | plot height | column width | top radius |
| --- | --- | --- | --- |
| `popover` (default) | 56px | up to 14px | 2px |
| `panel` | `--chart-height-panel` | up to 24px | 4px |

## When to use this component
Token or request usage over time: the context-ring popover (hourly buckets
since the chat started) and the usage page (a fixed window with `yTicks`).

## Where to use this component
Popovers, inspector panels and dashboard cards. It does not clip and draws no
tooltip, so it fits inside small popovers.

## Why to use this component
The Recharts `Chart` does not fit a 56px strip and its tooltip is clipped in a
popover. UsageBars is plain divs with transform motion, a single tab stop and
a screen-reader table.

## How to use this component
The block is a presenter. The caller buckets its data, formats labels and
shows the readout of the selected bucket.

```tsx
const { buckets } = bucketUsageSlots(timeline.slots, { toMs: now, maxBars: 24 });
<UsageBars
  buckets={buckets.map(toBar)}           // { key, label, valueText, segments: [{ id, value }] }
  series={[{ id: "new", color: "chart-1", label: copy.newInput }, { id: "cached", color: "chart-5", label: copy.cached },
    { id: "output", color: "chart-2", label: copy.output }]}
  selectedIndex={selected} onSelect={setSelected}
  axisLabels={[{ index: 0, text: "9" }, { index: buckets.length - 1, text: "15" }]}
  note={buckets.length === 1 ? copy.justStarted : undefined}
  ariaLabel={copy.chatUsage}
/>
```

Props:

- `buckets`: `{ key, segments: [{ id, value, subtask? }], label, valueText }[]`.
  `label` and `valueText` fill the sr-only table and the selection
  announcement. `subtask` (0..`value`) is the part of the segment that came
  from subtasks; see "Subtask split" below.
- `series`: `{ id, color, label }[]`; order is the stacking order (bottom
  first). `color` is `chart-1` … `chart-6` (`--context-chart-*`). The block
  draws no legend; product legends reuse the same list.
- `size`: `popover` | `panel`.
- `state`: `ready` | `loading` | `empty`. A ready chart whose buckets are all
  zero shows the empty look too.
- `selectedIndex` / `onSelect(index | null)`: controlled when `selectedIndex`
  is passed. Mouse hover follows the pointer; a touch tap toggles a bucket;
  ←/→/Home/End move; Esc, blur and a press outside clear.
- `axisLabels`: `{ index, text }[]`; labels near an edge align to it.
- `minSlots` (default 8): the plot keeps at least this many slots, so a few
  buckets sit at the start instead of stretching.
- `yTicks` (`panel` only): `{ format(value) }`. The scale rounds up to a clean
  top; half and top gridlines are drawn and labelled in a left gutter. The
  gutter stays while loading or empty (just "0"), so data arriving never
  shifts the plot.
- `emptyLabel`, `loadingLabel`, `note`, `ariaLabel`.
- `emphasis`: `"conversation"` | `"subtask"` | `null`, set while a linked
  legend row is hovered or focused (`KeyValueRow onHighlightChange`).

Non-zero buckets are at least 2px tall; segments split a column by their
share of its total, so any unit (tokens, dollars, fractions) fills it.
Segments and parts touch: a column has no gaps.
Selecting a bucket dims the others to 40%. A selection whose bucket goes away
(the buckets empty, or another bucket now sits at that index) is cleared with
`onSelect(null)`.

### Subtask split

Pass `subtask` only for one chat's usage (session scope) that delegated work;
never for all chats, whose bars stay solid. Each new / cached / output
segment then splits into its conversation part (solid, below) and its
subtask part (hatched, on top), with no gap between. The hatch is built from
the segment's own color only, so it reads the same in both themes:

```css
repeating-linear-gradient(135deg, c 0 2px, color-mix(in srgb, c var(--hatch-alpha), transparent) 2px 4px)
```

`--hatch-alpha` is 40%. When either part of a segment would be under 2px
(plot heights are fixed per size), the segment is drawn whole in the style of
its larger part. An output part under 1px can still vanish under the top
radius, as before.

Pair the chart with two `KeyValueRow` legend rows on the cached color
(`swatchColor="var(--context-chart-5)"`): conversation solid, subtask
`swatchPattern="hatched"`. Their `onHighlightChange` sets `emphasis`:
`subtask` raises the light stripes to 70%, `conversation` dims the hatched
parts to 40%, like the selection dim. Selection, keys and Esc are unchanged;
a selected bar keeps its hatched parts.

### Bucketing helper

`bucketUsageSlots(slots, { fromMs?, toMs?, maxBars?, weekStartsOn? })` takes
15-minute slots `[startMs, ...values]` and returns `{ stepHours, buckets:
[{ startMs, endMs, values }] }`. It picks the smallest step from 1, 2, 3, 6,
12 hours, 1, 2 or 7 days whose bucket count is at most `maxBars` (default
24). Empty buckets stay as gaps. `fromMs` defaults to the earliest slot and
`toMs` (exclusive, usually now) to the end of the latest slot.

Buckets sit on a fixed local-time grid, so a rolling window keeps its
boundaries from hour to hour and day to day:

- below a day: multiples of the step from local midnight (0, 6, 12, 18);
- 1 day: local midnight; 2 days: a fixed grid of local days (even day
  numbers since 1970-01-01);
- 7 days: the week start, `weekStartsOn` (0 Sunday … 6 Saturday, default 1
  Monday). Pass the locale's week start when it differs.

Starts are built from wall-clock fields, so a daylight-saving change only
lengthens or shortens the one bucket it falls in (a start inside a skipped
hour moves to the first hour that exists). Half-hour and 45-minute time
zones work the same way. `alignUsageBucketStart(ms, stepHours, weekStartsOn?)`
returns the bucket start for a time.

## Who can use this component
Product containers that already hold usage numbers and copy.

## Best practice
Keep bucketing in the caller (`bucketUsageSlots`), pass the same `series`
list to the legend rows, and show the selected bucket in the readout above
the chart. Split a chat only when it delegated work (some subtask value is
above zero). In a Radix popover, prevent its Esc dismissal while a bucket is
selected (`onEscapeKeyDown`), so the first Esc clears the selection.

## Wrong use cases
Do not use it for a single fraction (`ProgressMeter`), totals without a time
axis (`UsageSummaryRows`) or multi-series charts that need a legend and a
tooltip (`Chart`). Do not add a floating tooltip. Do not split all-chats
usage or draw gaps, outlines or surface-color lines between parts.

## Motion
Transform-only (WAAPI through `animateMotion`):

- First show and a new bucket count: columns grow from the baseline over
  `--motion-deliberate` (decelerate), 12ms apart, with the whole stagger
  capped at `--motion-slow`.
- Same bucket count, new values (a live update, a session switch): each
  column eases from the height it painted to the new one over `--motion-slow`
  (FLIP via `scaleY`). An update in flight starts from what is on screen.
- A hatched part that was not drawn before fades in over `--motion-base` and
  grows up from its boundary over `--motion-slow`; the column FLIP above
  carries existing parts.
- Selection dims over `--motion-fast`; so do the legend emphasis (the hatch
  lift and the hatched-part dim), as opacity fades.
- Reduced motion (OS or the app setting): columns appear at their final
  height at once; new hatched parts only fade in; the dims stay opacity
  fades.

## Accessibility
One tab stop, `role="group"` named by `ariaLabel` (`role="status"` while
loading). An sr-only table lists every bucket; a polite live region speaks
the selected bucket. The focus ring keeps `--focus-ring-room` of clear space
from the axis labels, so it reaches `--focus-ring-room` plus
`--focus-ring-width` (5px) outside the chart; a clipping parent must leave
that room.

## Tags
usage, tokens, chart, bars, stacked, timeline, context, subtask, hatch
