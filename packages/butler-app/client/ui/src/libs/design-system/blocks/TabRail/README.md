# TabRail

## What is this component

Live previews of Butler's tabs beside the conversation, made of
`LiveTabCard`s. It fills its positioned parent and takes no pointer input
outside the cards. It picks its layout from that parent's width:

| Width | Mode | Geometry |
| --- | --- | --- |
| 960px or more | `full` | 208px cards (32px title row, 16:10 frame), 16px from the top and end edge, 12px apart |
| 720–959px | `compact` | 128×80 thumbnails. The title is a tooltip. Needs-you adds an xs **열어서 확인** button |
| under 720px | `shelf` | A 46px TintedGlass strip across the top with 48×30 chips (52px where controls grow to the 44px touch target, so the +N pill's focus ring stays inside the glass). It scrolls sideways on overflow without a scrollbar (the TabStrip rule), never the page |

- Up to 3 cards, or 2 when the parent is shorter than 600px.
- The rest collapse into "+N": stacked favicons plus a count, named by `labels.more(count)`.
- Cards enter with a fade and a 4px rise (`--motion-base`) and leave over `--motion-fast`.
- Under reduced motion they come and go at once, and the thinking marks are still.

## When to use this component

Use it while Butler browses in the background, so the user sees its tabs
without opening the browser area.

## Where to use this component

Use it in the `rail` slot of `ConversationShell`, inside the chat card of
`AdaptiveShell`.

## Why to use this component

The breakpoints, the cap, "+N", the motion and the room the column makes all
live in the DS. The product container only maps tabs to props.

## How to use this component

```tsx
<ConversationShell railView={sessionId} rail={areaOpen ? null : (
  <TabRail view={sessionId} tabs={tabs} onMore={(id) => openConversationBrowser(sessionId, id)}
    labels={{ region: copy.rail.region, close: copy.closeTab, more: copy.rail.more }} />
)} composerReserve={reserve}>…</ConversationShell>
```

- `tabs`: in display order (needs you, busy, error, idle; newest action first
  within a group). Each tab is the `LiveTabCard` props plus `id`. Hidden cards
  are not rendered, so subscribe frames only for the first `tabRailCap(height)`.
- `mode`: `auto` (default), or force `full`, `compact` or `shelf`.
- `view`: tabs present when the view changes do not play their entrance.
- `onMore(firstHiddenId)`: open the browser area on the first hidden tab.
- Helpers: `tabRailMode(width)`, `tabRailCap(height)`, `splitRailTabs`,
  `railColumn` (the column geometry the shell's CSS applies).

## Who can use this component

The App's `AgentTabRail` container: it rolls child sessions up to the
conversation, never shows the user's own tabs, and hides the rail while the
browser area is open.

## Best practice

- Pass `rail={null}` while the browser area is open. The streams pause and the
  column returns.
- Keep frames in a non-persisted module map (`useLiveFrame(tabId)`).

## Wrong use cases

- Do not use it on phones or remote clients: frames never leave the desktop.
- Do not use it for the user's own tabs.
- Do not put it outside a positioned parent.

## Tags

browser, tabs, rail, live, preview, shelf, background, conversation
