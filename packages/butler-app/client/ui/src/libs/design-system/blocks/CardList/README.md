# CardList

`CardList` renders repeated card-shaped rows with a shared header, actions, and
optional bounded internal scrolling.

Use it for settings lists, skill lists, server lists, or other repeated
management rows where each item needs a title, description, metadata, and row
actions. Product components map domain records into `CardListItem` props.

Set `maxVisibleRows` when a group should keep a compact height and scroll
internally.

## Settings flush variant

Inside a settings section card (`SettingsSection` / `FormSection`) the
section card is the only surface: `CardList` and `CardListItem` render flush,
with no border, fill, radius or padding of their own, and rows are divided by
the same hairline as every other settings list row. Nothing to pass: the
variant follows the DOM, so a list in a dialog opened from a section (a
portal) keeps its cards. A `CardListItem` placed directly in a section card
renders flush too. Inside a section, leave `title` and `empty` unset: the
section title names the list and `SettingsSection state="empty"` owns the one
empty message.

The flush variant was chosen over the plain `ListRow`: `ListRow` has no
actions slot and takes only string descriptions, so moving the settings rows
to it would mean a new DS slot plus rewriting every row; the flush variant is
a stylesheet rule and keeps every row component as it is.

Row `actions` center on the title's line, whatever their height and however
many lines the description runs; they never center on the whole card.

A description truncates text to one line. It may also hold controls (a row
switch field, a site field); it keeps `--focus-ring-room` past its clip, so
their focus rings stay whole.
