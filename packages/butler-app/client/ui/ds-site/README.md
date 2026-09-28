# DS site

Standalone, static build of the Butler DS Viewer: no gateway, no API. Every viewer route lives in
query params (`?page=components/Button&theme=dark&locale=ko#anchor`), and in-app navigation only
rewrites the query, so the site works on any static host.

## Build

Run from `packages/butler-app/client/ui`:

| Command | Base | Output | Host files |
| --- | --- | --- | --- |
| `npm run build:ds-site` | `/` | `dist-ds-site/` | `CNAME`, `404.html` |
| `npm run build:ds-site:ds` (`DS_SITE_BASE=/ds/`) | `/ds/` | `dist-ds-site-ds/` | none |

Environment:

- `DS_SITE_BASE`: public path the site is served under. Default `/`: the standalone site with
  relative asset URLs, as deployed today. Any other value such as `/ds/` builds absolute asset
  URLs under it.
- `DS_SITE_OUT_DIR`: output directory, relative to the UI package. Default `dist-ds-site` for `/`,
  `dist-ds-site-<base>` otherwise (`/ds/` -> `dist-ds-site-ds`), so a sub-path build never
  overwrites the Pages artifact.
- `DS_SITE_HOST_FILES`: `1` or `0` to force emitting the host-owned `CNAME` and `404.html`
  (from `host/`). Default: only when the base is `/`. A combined site owns its own CNAME and its
  single 404 page, so a sub-path build leaves them out.

Every build also emits `LICENSE.txt`, `third-party-licenses.txt` and `ds-404-redirect.js`.

## Path-style links and 404

Static hosts 404 on path-style links like `/ds/components/Button`. `ds-404-redirect.js` (source in
this folder; the build bakes the base in) maps them onto the query route with `location.replace`:

```
/ds/components/Button?theme=dark#variants -> /ds/?page=components%2FButton&theme=dark#variants
/ds                                       -> /ds/
```

It only acts on paths under its own base and does nothing elsewhere, so a combined site's single
`404.html` can include it unconditionally:

```html
<script src="/ds/ds-404-redirect.js"></script>
```

It also exposes `window.butlerDsSite = { base, redirectTarget(base, pathname, search, hash), redirect() }`
for a 404 page that wants to route manually. The standalone `/` build inlines the same helper into
its own `404.html`.

## Checks

`bun run ds-site:check` (repo root) builds both bases and runs, for each, the leak check
(`tests/smoke/ds-site-leak-check.ts [distDir]`) and the browser smoke
(`[DS_SITE_BASE=/ds/] bun run tests/smoke/ds-site-smoke.ts`). The smoke serves the output like
GitHub Pages (the `/ds/` build mounted in a combined-site fixture whose 404 includes the helper)
and checks Overview, deep links, sidebar navigation, path redirects and zero foreign requests.

## Deploy

`.github/workflows/ds-site.yml` builds and checks both bases but deploys only the base `/` build
(`dist-ds-site/`) to GitHub Pages.
