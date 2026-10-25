# InspectorPanel

## What is this component
A compact panel shell for right-side inspector content.

## When to use this component
Use it for grouped diagnostic, context, worker, and artifact panels.

## Where to use this component
Use it in side panels: the `ConversationShell` aside (session details) and the
`ManagementPage` aside.

## Why to use this component
It keeps inspector sections consistent without carrying domain logic.

## How to use this component
Pass a title, optional description, icon, action, and children.

## Who can use this component
Inspector containers and higher-level blocks.

## Best practice
Use it with `KeyValueRow`, `ActivityFeed`, or `WorkerActivityRow`.

## InspectorInset

Full-width side-panel content that is not an `InspectorPanel` card (a `Section`,
an `ActivityFeed`) goes inside `InspectorInset`, which applies the panel's
`--inspector-inline-padding` (none when the container sets no gutter). Pass
`fill` when the content should take the remaining column height. Product code
must not recreate the inset with `style={{ marginInline: ... }}`.

## Wrong use cases
Do not use it for full page dashboard regions. Use `Section` or `SurfacePanel`.

## Tags
inspector, panel, section, diagnostics
