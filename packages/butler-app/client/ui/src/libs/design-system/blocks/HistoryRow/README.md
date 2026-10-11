# HistoryRow

## What is this component
`HistoryRow` is one visit on one dense line: favicon, title, the muted host, and the visit time right-aligned at the end. Hover or keyboard focus swaps the time for the row actions; selection mode turns the row into a checkbox with a leading check box. `HistoryGroup` is a day of rows under a quiet heading.

## When to use this component
Use it for browsing history and other dated logs of pages the user can reopen, delete or select.

## Where to use this component
On the history page, one `HistoryGroup` per day inside a reading-width `PageContainer`.

## Why to use this component
Mainstream browsers list history as dense single-line rows with a site icon and aligned times; actions and check boxes appear only when needed so titles stay scannable.

## How to use this component
Pass display-ready `title`, `url`, `iconSrc`, a formatted `time` and `onOpen`. Put icon actions in a `ButtonContainer size="icon-sm"`. For bulk actions set `selecting`, `selected` and `onSelectedChange`.

## Who can use this component
Product containers that own history data, formatting and commands (HistoryPage).

## Best practice
Enter selection mode only from an explicit Select action; hide it again after the bulk action or Cancel.

## Wrong use cases
Do not use it for suggestions while typing (use `SuggestionList`) or for generic data rows with descriptions (use `ListRow`).

## Tags
browser, history, visits, favicon, selection, row, time
