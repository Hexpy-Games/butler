# ComposerQueuePanel

`ComposerQueuePanel` renders editable queued message rows inside the composer
adjunct area.

Use it inside `ComposerCard`'s `adjunct` slot when a draft has been queued for
later dispatch while another task is active. The block is presenter-only:
product surfaces map queued message records, copy, attachment labels, and edit
or delete handlers before passing final item props into this block.

The title row is owned by `ComposerAdjunctPanel` so queued messages, todo
progress, and worker activity share the same composer-attached rhythm.
