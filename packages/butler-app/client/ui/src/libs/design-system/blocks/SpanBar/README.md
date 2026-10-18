# SpanBar

## What is this component
One span of a trace on the trace's shared time axis: a pill on a 6px track,
placed by its start offset and sized by its duration. `SpanAxis` labels the
axis; `SpanRow` indents a trace row by its nesting depth.

## When to use this component
Request traces and log waterfalls: when each step started, how long it took,
and which steps failed or waited.

## Where to use this component
Settings › Logs › message trace, and any inspector that lists the steps of
one run.

## Why to use this component
Every bar of a trace shares one `total`, so start offsets and durations line
up across rows, including nested rows.

## How to use this component

```tsx
<SpanAxis total={7112} inset="disclosure" maxDepth={maxDepth} format={formatSeconds} />
{spans.map((span, index) => (
  <SpanRow key={span.id} depth={span.depth} maxDepth={maxDepth}>
    <DisclosureRow title={span.title} meta={span.lengthText} open={…} onToggle={…}
      description={<>{span.startText}
        <SpanBar offset={span.offset} duration={span.duration} total={7112}
          tone={span.tone} index={index} label={span.spokenText} /></>}>
      {details}
    </DisclosureRow>
  </SpanRow>
))}
```

### SpanBar
| Prop | Type | Notes |
| --- | --- | --- |
| `offset` | number | Start, in the unit of `total` (ms from the trace start). |
| `duration` | number | Clamped so the span ends at `total` at the latest. |
| `total` | number | The whole trace; the same for every bar of a trace. |
| `tone` | `default` \| `parent` \| `danger` \| `warning` \| `muted` | parent: has children; muted: an app-side hop. |
| `index` | number | Row position for the grow-in stagger (capped at 12 rows). |
| `label` | string | Visually hidden text, e.g. "시작 +0.58초, 2.00초". |

The bar is at least 3px wide, so a 4ms step in a 7s trace stays visible. A
`total` of 0 or less, or a non-finite value, draws the empty track; a
non-finite `offset` or `duration` counts as 0.

### SpanAxis
`total`, optional interior `ticks` (default 1·2·5 steps), `format` for each
label (default "0s" / "412ms" / "2s"), `inset` and `maxDepth`. 0 and the total are
always shown. Tick density follows the axis width (about one label per
64px): an interior tick too close to its neighbour or to the total is
dropped, so labels never collide at compact widths. `inset="disclosure"` starts the axis where a DisclosureRow's
description column starts (selection surface).

### SpanRow
`depth` (0 for a root span) indents the row by 16px (`--space-lg`) per level.
A SpanBar inside reaches back to the shared axis, so nested bars line up;
rows are spaced like adjacent DisclosureRows.

Pass the trace's deepest level as `maxDepth` to every SpanRow and to the
SpanAxis. A bar reaches back at most the row's inner inset (`--space-sm`
plus the chevron line); when the deepest indent passes that, the whole axis
shifts right by the difference, so every bar keeps `--space-sm` inside its
own row's hover and open fill. Shallow traces (16px steps up to the inset)
do not shift.

## Who can use this component
Any container that has already mapped trace records to offsets, durations,
depths and copy. The block has no domain types.

## Best practice
Pass one `total` to the axis and every bar. Put the failure or wait reason in
the row title, meta or details: tone alone never carries it.

## Wrong use cases
Not for progress toward a goal (`ProgressMeter`) or usage over days
(`UsageBars`).

## Motion
Each bar grows in from its start (`transform: scaleX`, `--motion-deliberate`,
decelerate), rows `--motion-stagger-row` apart. Reduced motion (the app
setting, the DS Viewer scope or the OS) fades the bar in place instead. Tone
changes cross-fade the color (`--motion-base`); geometry is data and updates
without animation. Remount the rows (a new `key`) to replay the grow-in for a
new trace.

## Tags
trace, span, timeline, waterfall, log, duration
