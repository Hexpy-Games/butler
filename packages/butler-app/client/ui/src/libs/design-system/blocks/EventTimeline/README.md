# EventTimeline

## What is this component
A vertical run of dated events. `EventTimelineItem` puts the event-kind
`marker` in a one-icon (`--space-2xl`) column beside its content, and a
`--border-hairline` connector in `--line` joins each marker to the next
event.

## When to use this component
Use it for a history of records over time (created, updated, completed,
reported), grouped by day under a `Section`.

## Where to use this component
Project dashboard History tab (`ProjectHistoryPanel`).

## Why to use this component
The marker column, connector geometry and marker tone live in the DS, so
product code composes rows instead of owning timeline CSS.

## How to use this component
```tsx
<EventTimeline>
  <EventTimelineItem marker={<CheckCircle2 />}>
    <Stack gap="xs">
      <NavRow label={title} multiline meta={meta} actions={<ChevronRight />} onClick={open} />
      <Box paddingStart="sm"><Button variant="borderless" size="xs">…</Button></Box>
    </Stack>
  </EventTimelineItem>
</EventTimeline>
```

## Who can use this component
Dashboard containers that already own the event data and formatting.

## Best practice
Pass exactly one content node per item; keep time and action labels outside
the block.

## Wrong use cases
Do not use it for inspector progress; use `ActivityFeed`. Do not use it for
navigation lists without a sequence; use `NavRow`s in a `Stack`.

## Tags
timeline, history, events, dashboard, project
