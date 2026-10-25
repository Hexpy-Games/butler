# VersionHistory

## What is this block
A document's version history: one dense row per version, newest first, with
who made it (나, or 버틀러 with the Butler-ink mark) and when. Picking a row
previews that version; the footer action restores it. Put it in a `Popover`:
on a phone the popover spans the screen under its trigger (the popover sheet).

| Export | Props |
| --- | --- |
| `VersionHistory` | `entries` (`id`, `author` user · butler, `authorLabel`, `time`, `dateTime`), `selectedId`, `onSelect`, `label`, `currentLabel`, `action` |

## When to use this block
- The 버전 기록 of an editable 버틀러 document.
- Not for a read-only deliverable's file revisions (the artifact viewer keeps its version select).

## Accessibility
- `role="listbox"` with options; the previewed version is `aria-selected`.

## Tags
document, versions, history, restore
