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

### Tab rail

`rail` mounts a `TabRail` (Butler's live tabs) over the shell. `railView` (the
conversation id) latches the room the column makes. While the rail shows a tab,
and for the rest of that view once it has, the shell sets `data-rail="reserved"`:

- Full (960px or wider) and compact (720px or wider): the message column and the
  floating composer keep their width and centring. They move left only as far
  as they must to stay `--tab-rail-clearance` (24px) clear of the rail. At
  1440 with the sidebar open, that is 65px. They narrow only when the move would
  bring them within 24px of the card's leading edge (`railColumn` in TabRail
  computes the same numbers).
- Narrower than 720px: the shelf strip sits on top, and the messages start below
  it (`--conversation-rail-top`).
- Cards that come and go later never move the column back. Pass `rail={null}`
  while the browser area is open. The column then returns, and a later rail
  reserves room again.

The rail sits 16px into a shell card (`--conversation-top-reserve`), or under the
title bar in the flat frame. The composer follows through
`--conversation-column-width` and `--conversation-column-shift`, which
ComposerCard reads.

```tsx
<ConversationShell composerReserve={reserve} railView={sessionId}
  rail={areaOpen ? null : <TabRail view={sessionId} tabs={tabs} labels={labels} onMore={openFirstHidden} />}>
  …
</ConversationShell>
```

### Aside

`aside` puts content in the conversation's right margin (session details:
open requests, the task, results, attachments, environment). The shell owns
where it sits and scrolls it in a scroller of its own (the shared edge fade,
a scrollbar lane only while a classic scrollbar is drawn):

- Docked (a 960px shell or wider; a floating aside docks again from 992px, so a
  width on the line never flaps): flat on the shell's background, 272px
  (`--conversation-aside-width`), `--space-lg` from the top rail line, the end
  and the bottom. It stays put while the messages scroll. The column and the
  composer follow the rail rule: they keep their width and move left only as
  far as they must to stay `--tab-rail-clearance` clear of it, through
  `--conversation-column-width` and `--conversation-column-shift`.
  `onColumnRect` then reports the aside's far edge as `right`, so a background
  keeps the aside clear too.
- Floating (narrower, e.g. beside the browser area): one TintedGlass panel over
  the conversation, ending above the composer, shown only while
  `asideFloatOpen`. The column does not move.

Pass a function to get the layout (`"docked" | "floating"`), and drop your own
cards on glass: margin variant B is one flat `Card` per section, 12px apart
(`Stack gap="md"`), docked; the same sections bare on the glass. The aside
element carries `data-layout` and the shell `data-aside`. Each layout enters
and leaves with the DS Presence fade, so opening, closing and a docked/floating
flip cross-fade. A closed aside forgets its layout, so reopening after a resize
mounts it straight in the right place.

Motion: when a docked aside opens or closes (or the rail's room comes or goes)
the shell's CSS moves the column at once, and `ConversationColumnGlide` slides
it from where it was on screen (FLIP) on a transform, `--motion-slow` with
`--motion-ease-emphasized`. The message list, the floating composer and the
jump button carry `data-column-glide` and travel together; the docked aside
rides along, entering from the right as the column makes room and leaving to
the right as it comes back, so the pane pushes the column and never covers it.
Nothing reflows while it moves: a width change applies before the glide (text
wraps once) and the transcript keeps its scroll position. A floating aside
fades in and out over the conversation; the column does not move. Under
reduced motion everything moves at once, with no fade. Both layouts keep one inset on
the start and the end, whatever the scrollbar (overlay, classic or hidden). Name
the landmark with `asideLabel`. Without `aside` the shell renders exactly as
before. A docked aside and a `TabRail` share the right margin: show one at a
time. The shell enforces the order: while the aside shows or is still leaving,
a rail is held (hidden and inert), and once the aside's exit has ended the
rail fades in, so its cards never show under the leaving pane. The column
makes room for the rail as the aside leaves, in one move.

```tsx
<ConversationShell composerReserve={reserve} asideLabel={copy.sessionDetails} asideFloatOpen={detailsOpen}
  aside={detailsOpen ? (layout) => <SessionDetails layout={layout} /> : undefined}>
  …
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

conversation, chat, virtual-list, scroll, composer-reserve, background, wallpaper, rail, tabs, aside, session details
