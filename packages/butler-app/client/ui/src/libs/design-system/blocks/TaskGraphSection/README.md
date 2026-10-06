# TaskGraphSection

## What is this component
`TaskGraphPanel`: the Tasks tab body (inset Section header with summary, empty
state, sections xs apart). `TaskGraphSection`: one plan graph as a
`DisclosureRow` (default selection surface, no children) with the graph below.

## When to use this component
Whenever a conversation has task graphs; with one graph pass
`collapsible={false}` and the goal as the panel description.

## Where to use this component
The inspector Tasks tab.

## Why to use this component
It encodes the approved spacing and inset: header to first row is the
Section gap (lg); folded rows xs apart; an open graph sm above and below;
the graph sits below the row so cards keep the inspector inset. Requires the
DisclosureRow that includes `e8be31c66` (main since 2026-10-05).

## How to use this component
```tsx
<TaskGraphPanel title={copy.title} icon={<Blocks />} headerMeta={copy.graphsSummary(n, running)} emptyLabel={copy.empty} empty={n === 0}>
  {ordered.map((g) => (
    <TaskGraphSection key={g.id} graphId={g.id} title={g.title} status={rollupTaskGraphStatus(statuses)} meta={counts}
      open={open.has(g.id)} onToggle={() => toggle(g.id)}>
      <TaskGraphCanvas … />
      {owner === g.id ? <TaskGraphDetail … /> : null}
    </TaskGraphSection>
  ))}
</TaskGraphPanel>
```

## Who can use this component
Task graph containers.

## Best practice
Order running, failed, waiting, done, cancelled; open running and failed
graphs by default; keep the open set in memory only.

## Wrong use cases
Do not pass the graph as DisclosureRow children.

## Tags
task, graph, section, disclosure
