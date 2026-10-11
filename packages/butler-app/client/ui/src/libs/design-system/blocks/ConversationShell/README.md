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
The shell supplies the named `conversation` inline-size container for empty-state
content. Within AdaptiveShell's `workspace` container, narrow conversation gutters
and composer insets follow the actual pane width even on desktop.

### Background layer

`background` mounts one layer behind everything in the shell, e.g. a
`Wallpaper` shared by the new chat and its messages. It paints over the
shell's `--conversation-bg`, under every child (the shell isolates it), is
clipped to the shell, is `aria-hidden` and never takes pointer input. It stays
mounted while the children swap, so the first send neither remounts nor
recompiles it. Its leading corners follow `--workspace-left-radius`, which is
0 in a compact conversation (560px or narrower), as on the new chat. Without
`background` the shell renders exactly as before.

Pair it with `PromptSuggestionList onContentRect` (external-wallpaper mode,
no `wallpaper`) for the new chat's keep-out, and with
`MessageListSurface onColumnRect` for the messages'. `onColumnRect` reports
`{ left, right, top }` in client CSS px: the column's edges (the composer
shares them) and the conversation's top. It reports once laid out and again
only when the column or the shell resizes or the window does; never on
scroll, and never the same value twice.

```tsx
<ConversationShell composerReserve={reserve} background={<Wallpaper scope="container" source={source} contentRect={keepOut} />}>
  {empty ? (
    <ConversationScroll masked={false} scrollable={false}>
      <PromptSuggestionList title={title} suggestions={suggestions} onContentRect={setPromptRect} />
    </ConversationScroll>
  ) : (
    <ConversationScroll>
      <MessageListSurface onColumnRect={setColumn}>{rows}</MessageListSurface>
    </ConversationScroll>
  )}
</ConversationShell>
```

## Who can use this component

Agents building Butler chat, transcript, or conversation preview surfaces.

## Best practice

Keep message mapping in product containers. Long timelines should use stable
virtual row keys and identity-preserving cache/server merges so scrolling over
cached history does not jitter.

The message list reserves room for the title bar that overlays it
(`--titlebar-safe-area-top`). In a shell card (`AdaptiveShell frame="cards"`)
no title bar overlaps it, and the card sets `--conversation-top-reserve` to a
plain inset instead.

## Wrong use cases

Do not use this for dashboards, settings, or inspector panels. Use app-shell
blocks such as `ChromeFrame`, `SurfacePanel`, or `InspectorPanel` instead.

## Tags

conversation, chat, virtual-list, scroll, composer-reserve, background, wallpaper
