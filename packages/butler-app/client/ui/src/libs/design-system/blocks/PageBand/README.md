# PageBand

## What is this block
`PageBand` is one 40px line on a `PageCard`'s top edge for page-scoped state:
who holds the tab (agent, user), an approval (waiting), a request for your
input (warning), picking (pick) and page events such as a blocked pop-up
(info). Label, detail, hint and up to three actions. There is no idle tone:
when nothing on the page needs saying, there is no band.

## When to use this block
Use it for state that belongs to one page and the verbs that act on it:
Take over, Give back to Butler, Stop task, Review, Allow.

## Container vs Presenter
The App maps the tab state to a tone and copy (butler-i18n `browser.*`) and
passes `size="xs"` buttons in a `ButtonContainer size="xs"`. It composes one
band per tab: when two states meet (Butler holds the tab and a pop-up is
blocked), the second becomes the detail and its action joins the first's.
On a `PageCard` with `reserveBand`, the band comes, changes tone and leaves
in a row that never moves; with no band the row is empty and the card's
surface starts below it, so nothing reads as a band.

## Usage

```tsx
<PageBand tone="agent" icon={<ButlerThinkingMark size="sm" state="working" />} label={copy.agentUsing}
  detail={step} actions={<ButtonContainer size="xs"><Button size="xs" variant="outline" text={copy.takeOver} />…</ButtonContainer>} />
```

## Accessibility
Label and detail are a polite live region; actions sit outside it.

## Responsive behavior
One line at every width: label and actions keep their size, only the detail
truncates. Below 560px the hint drops; below 360px the detail drops.

## Wrong use cases
- Do not put app-wide messages in the band; use `Notice` or a toast.
- Do not exceed three actions.
- Do not stack two bands; merge the second state into the detail.
- Do not mount and unmount the band on a bare card; use `PageCard reserveBand`
  so the page never moves.
- Do not fill the row with a status nobody can act on (Butler's tab, idle);
  leave it empty.

## Tags
browser, band, page state, agent, approval, picking
