# Segmentation compatibility fixtures

These checked-in fixtures preserve the curated multilingual boundaries, window
policy outputs, null/default behavior, and source-runtime summary consumed by
the Rust tests. They are frozen compatibility evidence rather than an
executable TypeScript oracle.

`uax17-cases.json` was generated from the Unicode 17 grapheme and sentence test
data embedded by `unicode-segmentation` 1.13.3. Replace it only when the pinned
Unicode data is deliberately updated.

Bun 1.3.11 reports ICU 74.2 and Unicode 15.1 in `process.versions`, while the
tested macOS binary dynamically loads `/usr/lib/libicucore.A.dylib`. The direct
runtime probe reported ICU 78.1 and Unicode 17.0. The fixture outputs and full
UAX comparison are the compatibility authority; the metadata fields are kept
only as evidence from the source runtime.
