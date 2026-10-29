# ArtifactList

ArtifactList renders compact generated-artifact rows for timelines and panels.

Use it when artifact references should read as a single grouped list with an
icon, title, and short metadata line. Domain components own artifact data and
open behavior; this block owns only the presentational row structure.

## Layout

The row layout follows the card's own width (a container query on the list),
never the window width:

- Actions sit on the name's row, right-aligned, as long as the name keeps a
  readable width (`--space-4xl` × 3, 120px).
- On a narrower card, the actions wrap to their own row, still right-aligned
  to the card's content edge. Several actions follow the same rule and wrap
  together.
- Cards 400px (25rem) wide or narrower use a 32px icon and a tighter gap.
