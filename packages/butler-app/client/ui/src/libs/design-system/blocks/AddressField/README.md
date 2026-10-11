# AddressField

## What is this block
`AddressField` is the browser toolbar's address: a security glyph, the bold
host with a muted path (truncating at the end), tags and the bookmark star.
A click, Enter or Space turns it into a plain `Input` with the full URL
selected; Enter submits, Escape and blur cancel.

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

## Accessibility
At rest it is a button named “Address: <url>”; in edit mode the input is
labelled, and the whole field carries the focus ring.

## Responsive behavior
It takes the remaining toolbar width; the text truncates at the end.

## Wrong use cases
- Do not show the full URL at rest.
- Do not use it as a form URL input; use `Input`.

## Tags
browser, address, url, security, bookmark
