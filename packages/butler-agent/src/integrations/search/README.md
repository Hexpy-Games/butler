# search integration

`packages/butler-agent/src/integrations/search/` owns URL discovery and page reading. Search providers find
candidate sources; page readers turn URLs into compact, source-bearing evidence
that Butler can cite or use in tool results.

## Key Files

- `provider.ts`: configured search provider selection, no-key search,
  key-based provider fallback, and source normalization.
- `page-reader.ts`: lightweight page extraction, readability conversion,
  challenge/CSR detection, and reader backend normalization.

## Boundaries

Search and read are separate concerns. Search should return normalized sources;
page reading should produce bounded evidence chunks. Telemetry must avoid raw
private queries and raw page dumps.

## Related Specs

- `SPEC-WEB-SEARCH-TOOL` - Web Search Tool
- `SPEC-LIGHTWEIGHT-PAGE-READER` - Lightweight Page Reader
