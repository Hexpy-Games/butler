# WorkerActivityPanel

`WorkerActivityPanel` renders a compact grouped list of worker activity rows.
Each row keeps worker label, status, and current activity on one primary line,
with the phase rail below that line.

Use it inside `ComposerCard`'s `adjunct` slot. It is presenter-only: product
surfaces should map worker records, controls, and detail blocks before passing
final row props into this block. The fixture renders the panel in its
composer-attached context because the panel is not a standalone surface.

The title row is owned by `ComposerAdjunctPanel` so worker activity and todo
progress share the same body-sized title, subdued opacity, and divider.
