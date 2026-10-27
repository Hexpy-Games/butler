# CardList

`CardList` renders repeated card-shaped rows with a shared header, actions, and
optional bounded internal scrolling.

Use it for settings lists, skill lists, server lists, or other repeated
management rows where each item needs a title, description, metadata, and row
actions. Product components map domain records into `CardListItem` props.

Set `maxVisibleRows` when a group should keep a compact height and scroll
internally.

Row `actions` center on the title's line, whatever their height and however
many lines the description runs; they never center on the whole card.

A description truncates text to one line. It may also hold controls (a row
switch field, a site field); it keeps `--focus-ring-room` past its clip, so
their focus rings stay whole.
