# AddressField

## What is this block
`AddressField` is the browser toolbar's address: a security glyph, the bold
host with a muted path (truncating at the end), tags and the bookmark star.
A click, Enter or Space turns it into a plain `Input` with the full URL
selected; Enter submits, Escape and blur cancel. At rest and in edit mode it
is a pill with fully rounded ends (`--radius-pill`), like the tabs above it,
one `--control-height-lg` (34px) tall so it reads as heavy as the tabs.

## When to use this block
Use it in `BrowserToolbar`. Butler pages (library, new tab) pass `title`
and `icon` instead of a URL.

## Container vs Presenter
The App owns the URL, the security state, bookmarks and navigation
(`onSubmit`), and may control edit mode (`editing`, Cmd+L).

## Usage

```tsx
<AddressField url={tab.url} security={tab.secure ? "secure" : "insecure"} tags={signedIn ? <Tag size="sm" …>{copy.signedIn}</Tag> : null}
  bookmarked={bookmarked} onToggleBookmark={toggle} onSubmit={navigate} labels={copy.addressLabels} />
```

## Suggestions
While editing, `onInputChange` reports the typed text and `onInputKeyDown`
runs before the built-in keys (prevent the default to take Enter or the
first Escape). `listbox={{ id, expanded, activeOptionId }}` makes the input
an ARIA combobox that controls a `SuggestionList`. Wrap the field in
`PopoverAnchor` and open `PopoverContent width="anchor" density="list"` so
the list is exactly as wide as the field.

## Accessibility
At rest it is a button named “Address: <url>”; in edit mode the input is
labelled, and the whole field carries the focus ring. With `listbox` the
input is a combobox (`aria-autocomplete="list"`, `aria-controls`,
`aria-expanded`, `aria-activedescendant`); focus never leaves it.

## Responsive behavior
It takes the remaining toolbar width; the text truncates at the end.

## Wrong use cases
- Do not show the full URL at rest.
- Do not use it as a form URL input; use `Input`.

## Tags
browser, address, url, security, bookmark
