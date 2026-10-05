# InlineReference

Inline, token-colored reference inside running text. It participates in the surrounding text baseline without a chip background or control padding. Domain identity, navigation and data stay outside the DS.

## Mention (default kind)

A document or conversation. Compose an existing DS icon and a text label. Provide `onClick` for navigation; omit it inside an editable decorator. `unavailable` lowers its text hierarchy without removing the historical label.

```tsx
<InlineReference icon={<FileText />} onClick={openDocument}>Q3 planning notes</InlineReference>
```

## External link (`kind="external"`)

An absolute http(s) URL. It renders a real anchor (`target="_blank"`, `rel="noopener noreferrer"`), which the desktop shell routes to the system browser (`setWindowOpenHandler` → `shell.openExternal`) and a browser opens in a new tab.

```tsx
<InlineReference kind="external" href={url} iconSrc={faviconSrc(url)}>First-run guide</InlineReference>
<InlineReference kind="external" href={url} iconSrc={faviconSrc(url)} />   {/* shows the domain */}
```

- **Label**: `children` is the title. Omitted, or equal to the URL, it shows the domain without `www.` (as written, so internationalized domains stay readable).
- **Tooltip**: the full URL, also the anchor's accessible description.
- **Icon slot**: a fixed rounded box (1.125em). The DS globe shows at once; when `iconSrc` decodes, the favicon fades in over it on a light plate (`--favicon-plate`, readable on dark surfaces too). On error, an empty image or no load within 4 s, the globe stays. Loaded and failed sources are remembered for the session, so re-renders never flash or refetch.
- **`iconSrc`** must be same-origin (the renderer CSP allows `img-src 'self' data:`): the app's favicon service, never a third-party favicon API. Leave it out for the globe.
- **Wrapping**: it is inline text, so long titles wrap with the sentence in paragraphs, list items, table cells and headings; long domains break anywhere. A word joiner keeps the icon with the first word.
- Hover underlines the label; focus shows the DS focus ring.

In markdown, use `MarkdownLink` with `MarkdownContent faviconSrc` instead of rendering this directly.

## Not for

In-app actions styled as links (retry, copy link, show more) use `Button variant="link"`; calls to action that leave the app (a notice's "Install Git") use `Button`; URLs the user reads or copies stay `Typo` text.
