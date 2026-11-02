# LiveTabCard

## What is this component

A live preview of one Butler browser tab. The full card has a 32px title row
(favicon, title, state, ×) above a 16:10 frame. The frame is drawn from a passed
`ImageBitmap` or a picture URL. The state paints the ring and adds a mark:

| `state` | Look |
| --- | --- |
| `busy` | `ButlerThinkingMark` and a faint ink ring |
| `held` | The `직접 조작 중` tag |
| `attention` | Amber ring and the state tag. With `needsYou`, an amber band with **열어서 확인** |
| `error` | Red tag. The frame is greyed, with `failure.label` and **새로고침** |
| `idle` | No mark |

Variants:
- `full`: the rail card (208px, set by `TabRail`).
- `compact`: a 128×80 thumbnail with no title row. The title is the tooltip. The favicon sits bottom-start and the state mark top-end. Needs-you adds an xs **열어서 확인** under it.
- `chip`: the shelf chip, a 48×30 frame and the site name. A needs-you chip shows its action and runs it.

`LiveTabFrame` is the frame alone: a 16:10 `MediaFrame` that draws a
bitmap on a canvas, for other places that show a tab's live frame (the
approval panel's `media`).

## When to use this component

Use it for Butler's tabs beside the conversation, usually through `TabRail`.

## Where to use this component

Use it in `TabRail`, and `LiveTabFrame` in `ComposerDecisionPanel media`.

## Why to use this component

Live tab previews share one look, one set of states and one click model. The DS
never imports the browser bridge: frames are props.

## How to use this component

```tsx
<LiveTabCard title={tab.title} favicon={tab.favicon} frame={bitmap} state="attention" stateLabel={copy.rail.needsCheck}
  needsYou={{ detail: copy.mfa, action: { label: copy.rail.openToCheck, onAction: () => openHandoffTab(tab.id) } }}
  onOpen={() => openConversationBrowser(session, tab.id)} onClose={() => closeTab(tab.id)} closeLabel={copy.closeTab} />
```

**Frames.**
- Pass the newest decoded `ImageBitmap` as `frame`.
- The canvas takes the bitmap's own size and CSS scales it, so a resize never redraws.
- Close the previous bitmap after passing the next one. A closed bitmap keeps its last pixels.
- A string `frame` is a picture URL, such as a masked still.
- No `frame` shows the favicon on the matte.

## Who can use this component

The App's `AgentTabRail` container (`useLiveFrame(tabId)`) and approval
containers.

## Best practice

- Keep frames out of persisted stores. Hold them in a module map.
- On a vault-filled or payment tab, pass the masked still instead of live frames.
- Closing a tab Butler uses needs no confirmation.

## Wrong use cases

- Do not use it for the user's own tabs. Use `TabStrip` for those.
- Do not use it for history stills. Use `WorkActivityBlock` for those.
- Do not make the frame interactive.

## Tags

browser, tab, live, preview, thumbnail, rail, screencast, agent
