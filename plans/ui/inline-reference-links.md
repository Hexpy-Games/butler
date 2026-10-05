# External links → InlineReference (product migration + favicon service)

Branch with the DS work: `ds/inline-reference-links`. Product code is untouched
there; this plan is the Codex follow-up.

## What the DS now provides

- `InlineReference kind="external"` (`@/butler-ds`):
  `<InlineReference kind="external" href={url} iconSrc={faviconSrc(url)}>Title</InlineReference>`.
  Real `<a target="_blank" rel="noopener noreferrer">` (Electron routes it through
  `setWindowOpenHandler` → `shell.openExternal`; browsers open a new tab).
  No children, or children equal to the URL, shows the domain. Full URL in the
  DS Tooltip and `aria-describedby`. Globe at once; the favicon fades in over it
  in the same 1.125em rounded slot (light plate `--favicon-plate`, so dark glyphs
  read in dark mode). On error, empty image or 4 s timeout the globe stays.
  Loaded and failed sources are remembered in memory for the session.
- `MarkdownLink`: a react-markdown `components.a` renderer. It renders http(s)
  links as external InlineReference, and mailto, `#fragment` and relative links
  as plain anchors (`target="_blank"`, same as today).
- `MarkdownContent faviconSrc?: (href: string) => string | undefined`: favicon
  resolver for every `MarkdownLink` inside it. Leave it out to show the globe.
- `isExternalHref(href)`: true for absolute http(s) URLs.

`iconSrc` must be same-origin. The renderer CSP is `img-src 'self' data:`, and
third-party favicon APIs are banned (privacy).

## 1. Favicon service (build first)

### Gateway endpoint (`packages/butler-agent/rust/crates/butler-gateway/src/gateway/http/favicons.rs`, new)

`GET /favicons?host=<ascii hostname>` → `200 image/*` bytes, or `404` (no icon,
blocked, timeout). Authenticate it like the other `<img>`-loaded gateway assets
(see the message-file image sources, `hooks/useMessageFileSource.ts`). If an
`<img>` request cannot carry auth, sign the URL the same way message files are
signed.

- **Input**: hostname only, lowercase ASCII (IDNA). Reject IP literals,
  `localhost`, single-label hosts, `.local`, `.internal`, `.localhost`, `.test`.
- **SSRF**: resolve DNS and reject loopback, private (RFC 1918), link-local,
  CGNAT 100.64/10, multicast, unspecified, ULA fc00::/7, fe80::/10, and
  IPv4-mapped forms of these. Connect to the address you validated, so DNS
  rebinding cannot swap it. This matters because the gateway is reachable over
  the LAN.
- **Fetch**: https only. (1) `GET https://{host}/`: read at most 512 KB and stop
  at `</head>`. Parse `<link rel~=icon|shortcut icon|apple-touch-icon>`, prefer
  PNG/ICO/WebP whose `sizes` is closest to 32–64 px, and resolve it against the
  final URL. (2) If that fails, `GET https://{host}/favicon.ico`. Allow at most
  3 redirects and re-run the SSRF check on every hop.
- **Request hygiene**: no cookies, no `Referer`, a generic UA,
  `Accept: image/*`. Requests go only to the site itself. Never use Google s2,
  DuckDuckGo icons, icon.horse or similar.
- **Limits**: 2 s to connect and 3.5 s in total per host (the DS gives up at
  4 s). The icon body is capped at 100 KB. Coalesce concurrent requests for the
  same host into one fetch, and run at most 4 outbound fetches at once.
- **Content**: sniff magic bytes and accept PNG, ICO, GIF, JPEG and WebP only.
  Reject SVG: it is a script vector if opened as a same-origin document. Never
  trust the upstream `Content-Type`.
- **Response headers**: `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cache-Control: private, no-store` (so the renderer's HTTP disk cache never
  writes; the DS keeps a per-session memory set).
- **Memory cache**: an LRU of 256 hosts holding positive entries (bytes + type)
  and negative entries (TTL 1 h, memory only).
- **Disk cache** (`$BUTLER_DATA/cache/favicons/<sha256(host)>.<ext>`): written
  **only** when a host is fetched successfully and is not already on disk.
  Never write on a hit: no touch, no atime or mtime update, no index file.
  Bounds are 500 files and 5 MB. Evict the oldest by mtime, and only inside that
  same write. An entry older than 30 days counts as a miss on read: refetch it
  and overwrite it. Negative results never go to disk. Do not scan or write at
  startup. Idle writes must stay at 0, per the IDLE-DISK gate.
- Keep it platform-neutral (no OS branches; see #260).

### Client helper (`packages/butler-app/client/ui/src/app/favicons.ts`, new)

`export function faviconSrc(href: string): string | undefined`: returns the
same-origin `/favicons?host=…` URL, built with the app's API base and signing
when needed. Return `undefined` (globe) for anything that is not http(s), for IP
literals and for local hosts. It must be a pure, stable function reference,
because MessageMarkdown memoizes its components.

## 2. Product call sites (7 files, 9 edits)

Base: origin/main `c54d1b761`. Line numbers refer to that commit.

| # | File:line | Today | Replace with |
|---|---|---|---|
| 1 | `components/conversation/MessageMarkdown.tsx:7` | `import { MarkdownContent, MarkdownTable, useStreamingReveal } from "@/butler-ds";` | `import { MarkdownContent, MarkdownLink, MarkdownTable, useStreamingReveal } from "@/butler-ds";` and `import { faviconSrc } from "@/app/favicons.ts";` |
| 2 | `components/conversation/MessageMarkdown.tsx:28-35` | `a: ({ children, ...props }) => (<a {...props} target="_blank" rel="noreferrer">{children}</a>),` | `a: MarkdownLink,` |
| 3 | `components/conversation/MessageMarkdown.tsx:79` | `<MarkdownContent data-test-class="markdown-document">` | `<MarkdownContent data-test-class="markdown-document" faviconSrc={faviconSrc}>` |
| 4 | `components/management/ProjectDocumentMarkdownContent.tsx:1,4,7-16,45-50` | `MARKDOWN_COMPONENTS.a` renders a raw `<a … target="_blank">` (or `<span>` without href) | Drop the `AnchorHTMLAttributes` import. Use `const MARKDOWN_COMPONENTS = { a: MarkdownLink };` (`MarkdownLink` from `@/butler-ds`; it already renders `<span>` when there is no href) and `<MarkdownContent faviconSrc={faviconSrc}>` |
| 5 | `components/artifacts/ArtifactViewer.tsx:32-41,124` | `MARKDOWN_COMPONENTS: Components = { a({ href, children, node, ...props }) { … <a … target="_blank"> } }` | `const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };` (import from `@/butler-ds`) and `<MarkdownContent faviconSrc={faviconSrc}>` |
| 6 | `components/settings/AboutSettings.tsx:95-97` | `<Typo.Body as="span" tone="primary" wrap="anywhere"><a href={info.repository_url}>{info.repository_url}</a></Typo.Body>` (browser-default blue underline, no target) | `<Typo.Body as="span" tone="primary"><InlineReference kind="external" href={info.repository_url} iconSrc={faviconSrc(info.repository_url)}>{repositoryLabel(info.repository_url)}</InlineReference></Typo.Body>`, where `repositoryLabel` returns the URL path without its leading slash (e.g. `owner/repo`), or the host when the path is empty. Do not pass the full URL as children: that shows only the domain. |
| 7 | `components/first-run/FirstRunKeyForm.tsx:58-62` | `<Button asChild size="sm" variant="link"><a href={spec.keyUrl} …>{`${copy.getKey} ↗`}</a></Button>` | `<Typo.Body as="span"><InlineReference kind="external" href={spec.keyUrl} iconSrc={faviconSrc(spec.keyUrl)}>{copy.getKey}</InlineReference></Typo.Body>` (drop the `↗`: the favicon or globe already says the link leaves the app) |
| 8 | `components/first-run/FirstRunWelcome.tsx:69-71` | `<Button asChild size="sm" variant="link"><a href={FIRST_RUN_GUIDE_URL} …>{copy.learnMore}</a></Button>` | `<Typo.Body as="span"><InlineReference kind="external" href={FIRST_RUN_GUIDE_URL} iconSrc={faviconSrc(FIRST_RUN_GUIDE_URL)}>{copy.learnMore}</InlineReference></Typo.Body>` |
| 9 | `components/first-run/FirstRunConsent.tsx:34-38` | `<Button asChild size="sm" variant="link"><a href={`${FIRST_RUN_GUIDE_URL}#ai-providers`} …><Typo.Text as="span" wrap="normal">{copy.consentProviderLink}</Typo.Text></a></Button>` | `<Typo.Body as="span"><InlineReference kind="external" href={`${FIRST_RUN_GUIDE_URL}#ai-providers`} iconSrc={faviconSrc(FIRST_RUN_GUIDE_URL)}>{copy.consentProviderLink}</InlineReference></Typo.Body>` (it wraps as inline text, so the `Typo.Text` wrapper goes) |

Rows 1–3 edit one file. In total that is 7 files: 3 markdown renderers (every
markdown link) and 4 standalone links. Then remove imports nothing uses any more
(`Button` in FirstRunWelcome/FirstRunConsent if unused, `AnchorHTMLAttributes`).
Run `bun run lint:ds` and shrink any per-file baseline it reports as freed
(raw `<a>`). Never grow a baseline.

Check any copy or string tests that match `↗` or the old `getKey` rendering
(`rg "↗|getKey" packages/butler-app/client/ui/src tests`).

### Audited and kept (no change)

| File:line | Kind | Why it stays |
|---|---|---|
| `components/conversation/GitDependencyNoticePresenter.tsx:22-26` | external URL, CTA | A Notice action ("Install Git") is a call to action, so `Button` stays (see the InlineReference guidance). |
| `components/settings/HostedModelForm.tsx:70-73` (`window.open(auth_url)`) | action | Starts an OAuth flow; it is not a link the user reads. |
| `app/setupSignIn.ts:52` (`window.open`) | action | Opens the sign-in page from a button. |
| `components/first-run/FirstRunKeyForm.tsx:80` (`variant="link"` retry) | action | In-app action → `Button variant="link"`. |
| `components/first-run/FirstRunProviderList.tsx:50-58` (show more) | action | In-app disclosure. |
| `components/first-run/FirstRunSignIn.tsx:47` (copy link) | action | Clipboard action. |
| `components/conversation/UserMessageText.tsx:42`, `SessionReferenceText.tsx:8`, `editor/ProjectSourceNode.tsx:23`, `editor/SessionReferenceNode.tsx` | internal reference | Already `InlineReference` mentions. |
| MarkdownLink mailto / `#fragment` / relative | mailto / internal | Stay plain anchors, as today. |
| `components/settings/LocalModelConfigForm.tsx:48`, `first-run/FirstRunCustomServer.tsx:56` | URL as input placeholder | Text the user types or reads, not a link. |
| DS `DocumentTile`, `AttachmentList`, `ArtifactList` `href` actions | download / open actions | Row actions, not links in text. |

Not in scope: auto-linking bare URLs in user messages (`UserMessageText`). They
are not hyperlinks today.

## 3. Verification

1. `bun run typecheck`, `bun run lint:design`, `bun run lint:css`, `npx eslint packages/butler-app/client/ui/src`.
2. Gateway, per the repo test rules in `plans/README.md`: put E2E on the stub
   tier in `crates/butler-e2e`. Add non-E2E tests only as
   `// test-category: security` for SSRF rejection (private IP, rebinding,
   redirect to a private address) and for the SVG and size-cap rejection. The
   disk-write check counts writes: a second request for the same host makes zero
   disk writes, and a new host makes exactly one.
3. Smokes: `bun run app:layout:smoke`, `bun run app:activity-layout:smoke`,
   `bun run app:design-system:smoke` (ds-conversation-stories). Run the
   MessageMarkdown unit test (`MessageMarkdown.signedFiles.test.tsx`).
4. E2E with a stubbed reply (no real model calls) containing a titled link, a
   bare URL, a long URL, a link in a table and in a heading, and a mailto:
   - every http(s) link is `a[data-kind="external"]`; mailto stays a plain `a`;
   - each `[data-slot="inline-reference-icon"]` has the same size in every
     state and settles to `data-favicon="loaded"` or `"fallback"` within 4 s;
   - the network log shows only same-origin `/favicons?host=` requests: no
     third-party image hosts and no request to the link's site from the renderer;
   - clicking opens the system browser in Electron (`shell.openExternal`) and
     the app window does not navigate;
   - at 375 px, light and dark: nothing overflows the message column, long URLs
     show the domain and wrap.
5. IDLE-DISK gate after the change: idle writes stay ~0. Reopening a
   conversation whose favicons are cached writes nothing under
   `$BUTLER_DATA/cache/favicons`.
6. DS review before merge: real screenshots against the DS (`InlineReference`
   showcase stories "External links", "Long titles and URLs wrap" and
   "Favicon fallback", and MarkdownContent "Links in a reply").
