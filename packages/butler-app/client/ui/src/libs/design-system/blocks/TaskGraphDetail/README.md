# TaskGraphDetail

## What is this component
The selected task, read-only: status Tag, notice, facts (`KeyValueRow`),
prerequisite links, the task document (`DocumentTile`) and the conversation
action.

## When to use this component
Under the `TaskGraphSection` that owns the selection.

## Where to use this component
The inspector Tasks tab.

## Why to use this component
One composition for every task state; copy and actions are props.

## How to use this component
```tsx
<TaskGraphDetail title={t.title} status={t.status} statusLabel={copy.status[t.status]}
  facts={[{ id: "assignee", label: copy.assignee, value: … }, …]}
  relations={[{ id: "after", label: copy.after, emptyLabel: copy.none, tasks }]}
  onSelectTask={setSelected}
  document={{ title: copy.document, meta, onOpen: openDocument }}
  conversation={sessionId ? { label: copy.conversation, onOpen: openConversation } : undefined} />
```

## Who can use this component
Task graph containers.

## Best practice
Use `TaskGraphStepLine` as the value of the "Now" fact while running. Omit
`conversation` for unassigned tasks.

## Wrong use cases
Not for editing a task.

## Tags
task, graph, detail, document, conversation
