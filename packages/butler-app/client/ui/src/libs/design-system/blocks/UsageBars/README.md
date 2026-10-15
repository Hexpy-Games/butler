# UsageBars

## What is this component
Stacked usage columns over time: one column per time bucket, its segments
stacked bottom-up in `series` order. Two sizes share one look:

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

- `buckets`: `{ key, segments: [{ id, value }], label, valueText }[]`. `label`
  and `valueText` fill the sr-only table and the selection announcement.
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

Non-zero buckets are at least 2px tall; segments split a column by their
share of its total, so any unit (tokens, dollars, fractions) fills it.
Selecting a bucket dims the others to 40%. A selection whose bucket goes away
(the buckets empty, or another bucket now sits at that index) is cleared with
`onSelect(null)`.

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
the chart. In a Radix popover, prevent its Esc dismissal while a bucket is
selected (`onEscapeKeyDown`), so the first Esc clears the selection.

## Wrong use cases
Do not use it for a single fraction (`ProgressMeter`), totals without a time
axis (`UsageSummaryRows`) or multi-series charts that need a legend and a
tooltip (`Chart`). Do not add a floating tooltip.

## Motion
Transform-only (WAAPI through `animateMotion`):

- First show and a new bucket count: columns grow from the baseline over
  `--motion-deliberate` (decelerate), 12ms apart, with the whole stagger
  capped at `--motion-slow`.
- Same bucket count, new values (a live update, a session switch): each
  column eases from the height it painted to the new one over `--motion-slow`
  (FLIP via `scaleY`). An update in flight starts from what is on screen.
- Selection dims over `--motion-fast`.
- Reduced motion (OS or the app setting): columns appear at their final
  height at once; the dim stays an opacity fade.

## Accessibility
One tab stop, `role="group"` named by `ariaLabel` (`role="status"` while
loading). An sr-only table lists every bucket; a polite live region speaks
the selected bucket. The focus ring sits `--focus-ring-room` outside the
chart, so a clipping parent must leave that room.

## Tags
usage, tokens, chart, bars, stacked, timeline, context
