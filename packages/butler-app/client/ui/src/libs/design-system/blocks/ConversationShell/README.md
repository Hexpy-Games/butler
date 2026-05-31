# ConversationShell

## What is this component

`ConversationShell` owns the conversation viewport, scroll area, and message
list surface.

## When to use this component

Use it for Butler chat timelines that reserve space for a floating composer.

## Where to use this component

Use it as the main conversation body, not inside cards or inspector panels.

## Why to use this component

It centralizes conversation width, scroll gutter, composer reserve spacing, and
stable timeline row positioning.

## How to use this component

Wrap `ConversationScroll` around either an empty state or `MessageListSurface`.
Use `masked={false}` for first-screen compositions that should not fade at the
scroll edges, and `scrollable={false}` for first screens whose inner rail owns
overflow. Use `virtualized` and pass a measured `height` for long timelines.
Product containers still own message data and submission.

## Who can use this component

Agents building Butler chat, transcript, or conversation preview surfaces.

## Best practice

Keep message mapping in product containers. Long timelines should use stable
virtual row keys and identity-preserving cache/server merges so scrolling over
cached history does not jitter.

## Wrong use cases

Do not use this for dashboards, settings, or inspector panels. Use app-shell
blocks such as `ChromeFrame`, `SurfacePanel`, or `InspectorPanel` instead.

## Tags

conversation, chat, virtual-list, scroll, composer-reserve
