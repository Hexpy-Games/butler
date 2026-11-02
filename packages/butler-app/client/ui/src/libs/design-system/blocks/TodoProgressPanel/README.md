# TodoProgressPanel

Glossary: 진행 내역 / progress log (`TodoProgressPanel`).

`TodoProgressPanel` renders the progress log as a compact checklist.

Use it inside `ComposerCard`'s `adjunct` slot for progress surfaces where each
row is a step state, not a toolchain or work-block body. The fixture renders the
panel in that composer-attached context because the panel is not a standalone
surface. Do not add its own card chrome, border, background, or shadow inside
the composer.

The title row is owned by `ComposerAdjunctPanel` so todo progress and worker
activity share the same body-sized title, subdued opacity, and divider.
