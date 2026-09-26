# Frozen prompt time zone data

The pack freezes the actual macOS ICU 78.1 / TZ 2026c data used by the
Bun 1.3.11 source fixture. Bun reports ICU 74.2 in its version metadata;
that ABI-facing value does not identify the installed resource version.
The developer exporter checks `u_getVersion` and `zoneinfo64.TZVersion`.

`source-2026c.btz` has 639 ICU names and aliases in 398640 bytes. It stores
ICU historical transitions and source-compatible annual rules as TZif v3.
`names-icu78.json` freezes English/root specific and metazone names with
historical metazone intervals. `provenance.json` contains per-record and
pack hashes. These are generated third-party data, not Rust source.

The native executable embeds the data. Clock construction indexes borrowed
static TZif slices and loads a fixed name table. Each formatting operation
parses only its selected zone, obtains offset/DST facts, and releases the
transition vectors. There is no growing zone/session cache, runtime ICU FFI,
JavaScript invocation, system zone-file read, or data download.

## Regeneration

The packed static source data can be rebuilt on the explicitly selected macOS
ICU 78.1 / TZ 2026c source host:

```sh
python3 generate.py --zoneinfo /usr/share/zoneinfo --output /tmp/butler-timezones
```

The developer-only Python exporter reads system ICU resources and uses the
selected zoneinfo POSIX footer only where ICU declares a final annual rule.
ICU historical DST flags and permanent final types are retained. Missing
SystemV files use the exact asserted ICU SystemV rule. The checked-in Bun
date/timezone goldens remain the compatibility evidence consumed by Rust tests;
baseline changes require a separately reviewed source-runtime fixture update.

BTZ2 layout: ASCII `BTZ2`, little-endian u32 record count, then records sorted
by ASCII-lowercase name. Each record is u16 name length, u16 canonical-name
length, u32 TZif length, UTF-8 name, canonical name, and TZif bytes.

The final export reproduced byte-for-byte in an independent output directory.
The format fixture checks 5624 Bun date/timezone cases and the alias fixture
checks all 639 ICU names (including 26 Intl-rejected aliases); this is
bounded compatibility evidence, not proof of all inputs or other platforms.
Legacy Date.parse formats and platform distribution remain separate work.

ICU data licensing: [Unicode License V3](https://www.unicode.org/license.txt),
retained in `LICENSE-UNICODE.txt`.
IANA time zone data are [public domain](https://data.iana.org/time-zones/tzdb/LICENSE).
[Apple distribution provenance](https://github.com/apple-oss-distributions/TimeZoneData).
