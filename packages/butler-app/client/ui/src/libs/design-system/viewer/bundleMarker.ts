// Lives only in the lazily loaded DS Viewer chunk. The build-output check in
// tests/smoke/ds-viewer-bundle-check.ts fails if it leaks into the entry chunk.
export const DS_VIEWER_BUNDLE_MARKER = "butler-ds-viewer:lazy-chunk";
