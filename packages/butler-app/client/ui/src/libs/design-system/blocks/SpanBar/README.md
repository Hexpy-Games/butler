# SpanBar

## What is this component
One span of a trace on the trace's shared time axis: a pill on a 6px track,
placed by its start offset and sized by its duration, in a trace tone. A
parent span can be split into its direct children's pieces (segments).
`SpanAxis` labels the axis; `SpanRow` places a trace row at its nesting
depth.

## When to use this component
Request traces and log waterfalls: when each step started, how long it took,
what a parent step spent its time on, and which steps failed or waited.

## Where to use this component
Settings › Logs › message trace, and any inspector that lists the steps of
one run.

## Why to use this component
Every bar of a trace shares one `total`, so start offsets and durations line
up across rows, including nested rows.

## How to use this component

Trace steps (owner-approved D5 pattern): text-indent rows, no chevrons, a
segmented bar per parent.

```tsx
<SpanAxis total={9840} inset="row" format={formatSeconds} />
{visibleSteps.map((step, index) => (
  <SpanRow key={step.id} depth={step.depth} indent="text" depthLabel={(depth) => `깊이 ${depth}`}>
    <DisclosureRow affordance="none" title={step.title} count={step.children.length || undefined}
      attention={step.problem} meta={step.metaNode} description={step.startText}
      open={…} onToggle={…} controlsId={…}
      bar={<SpanBar offset={step.offset} duration={step.duration} total={9840} tone={step.tone}
        segments={step.children.map(({ offset, duration, tone }) => ({ offset, duration, tone }))}
        index={index} label={step.spokenText} />}>
      {step.details}
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
| `tone` | `model` \| `tool` \| `app` \| `agent` \| `error` \| `wait` | Default `model`. Status first (error, wait), then the step's kind. |
| `segments` | `{ offset, duration, tone }[]` | One per direct child, same unit as `offset`. |
| `index` | number | Row position for the grow-in stagger (capped at 12 rows). |
| `label` | string | Visually hidden text, e.g. "시작 +0.58초, 2초". |

Tones map to the `--trace-*` fills (light and dark per theme): model (model
and HTTP requests, streams), tool (tool and MCP calls), app (send, deliver),
agent (turn, pick model, context, memory), error, wait (wait, retry,
warning).

The bar is at least 3px wide, so a 4ms step in a 10s trace stays visible. A
`total` of 0 or less, or a non-finite value, draws the empty track; a
non-finite `offset` or `duration` counts as 0.

**Segments.** The whole span stays filled: each direct child paints its
piece (clipped to the span; an overlap is cut at the earlier child's end)
and time no child covers keeps the span's own tone. The span is one pill
that clips its pieces, so only its outer ends are round and the joints are
square. Adjacent children alternate solid and a 2px diagonal hatch of the
tone and its `-alt` partner, so neighbours read apart without gaps or
color alone. Draw the same segments whether the row is open or closed.

### SpanAxis
`total`, optional interior `ticks` (default 1·2·5 steps), `format` for each
label (default "0s" / "412ms" / "2s"), `inset` and `maxDepth`. 0 and the total are
always shown. Tick density follows the axis width (about one label per
64px): an interior tick too close to its neighbour or to the total is
dropped, so labels never collide at compact widths.
- `inset="row"`: the `bar` line of a DisclosureRow (text-indent traces);
  `maxDepth` does not apply.
- `inset="disclosure"`: a DisclosureRow's description (row-indent traces),
  with the trace's `maxDepth`. A DisclosureRow has no chevron column (its
  chevron follows the title), so this is the row inset plus the shift.

### SpanRow
`depth` (0 for a root span) and `indent`:
- `indent="text"`: only the DisclosureRow's text indents (title line,
  description, panel), 16px (`--space-lg`) per level, at most 3 levels. The
  row fill and the bar keep the full width on the shared axis. A row deeper
  than 3 levels shows `depthLabel(depth)` after its description ("+6.13초 ·
  깊이 5") instead of indenting further.
- `indent="row"` (default): the whole row indents 16px per level; a SpanBar
  in the description lines up with the shared axis. Pass the trace's
  deepest level as `maxDepth` to every SpanRow and to the SpanAxis; the
  whole axis shifts right by the deepest indent, so every bar starts where
  the deepest row's description starts, `--space-sm` inside its fill.

Rows are spaced like adjacent DisclosureRows.

## Who can use this component
Any container that has already mapped trace records to offsets, durations,
depths and copy. The block has no domain types.

## Best practice
Pass one `total` to the axis and every bar. Put the failure or wait reason in
the row title, meta or details: tone alone never carries it. Mark problem
rows with DisclosureRow `attention`, never normal rows.

## Wrong use cases
Not for progress toward a goal (`ProgressMeter`) or usage over days
(`UsageBars`).

## Motion
Each bar grows in from its start (`transform: scaleX`, `--motion-deliberate`,
decelerate), rows `--motion-stagger-row` apart. Reduced motion (the app
setting, the DS Viewer scope or the OS) fades the bar in place instead. Segments grow with their span (they are clipped inside it). Tone
changes cross-fade the color (`--motion-base`); geometry is data and updates
without animation. Remount the rows (a new `key`) to replay the grow-in for a
new trace.

## Tags
trace, span, timeline, waterfall, log, duration, segments
