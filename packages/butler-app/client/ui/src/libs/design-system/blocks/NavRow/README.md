# NavRow

Use `iconInteractive` when the icon slot contains an actual control (for example,
a favorite toggle). It removes decorative `aria-hidden` from that slot. The
control owns its accessible label and stops click/key propagation to the row.
Use `multiline` for title/description rows: it adds vertical padding and aligns
the icon with the first text line. Single-line consumers retain their layout.
The label fills the available track so a composed title/status and metadata row
can share a consistent trailing alignment. Nested identity controls may opt into
Clickable's declared action/icon sizing; see Clickable's README.
Use `meta` for a second line that spans the full row: the first-line actions do
not consume its trailing space. Metadata aligns with the label after the icon.
`--nav-action-edge-offset` may cancel the row inset for internally padded action
targets; text metadata keeps its normal trailing inset.

## What is this block

NavRow is a Butler design-system block for building navigation rows with icon, label, optional badge, and inline actions.

## When to use this block

Use NavRow for sidebar navigation items, project rows, session rows, settings items, or any clickable list row in navigation context.

## Container vs Presenter

**NavRow is a presenter block.** It owns visual layout, states (active, disabled), hover behavior, and accessibility slots. It must not import Butler domain data, stores, routes, or app copy.

**Container responsibilities:** Domain components inject project names, session titles, route matching for active state, click handlers that navigate, app copy for labels, and domain-specific actions.

## Similar blocks

- Use **ListRow** for non-navigation list items or data rows without navigation semantics
- Use **SidebarItem** legacy component only during migration; prefer NavRow for new code
- Use **Clickable** primitive when you need a raw button-like container without navigation layout

## Usage

Import from the public design-system alias:

```tsx
import { NavRow } from "@/butler-ds";
```

Compose with DS primitives. Keep domain logic in containers.

```tsx
// Container example (domain component)
function ProjectRowContainer({ project }: { project: ProjectSummary }) {
  const navigate = useNavigate();
  const isActive = useMatch(`/project/${project.id}`);

  return (
    <NavRow
      icon={<Folder />}
      label={project.display_name}
      active={!!isActive}
      onClick={() => navigate(`/project/${project.id}`)}
      actions={<ProjectActions project={project} />}
      actionsVisibility="hover"
    />
  );
}
```

## Accessibility

- Uses `role="button"` via Clickable when interactive
- Supports `aria-current="page"` for active state
- Accepts `ariaLabel` prop for screen readers
- Falls back to string label for accessible name

## Responsive behavior

- Label truncates with ellipsis when space is constrained
- Actions can be set to hover-only visibility
- Touch targets meet minimum size requirements
- Works in narrow sidebar widths (240px+)

## Wrong use cases

- Do not use NavRow for table data rows; use ListRow or domain table components
- Do not use NavRow for form controls; use Field or form-specific blocks
- Do not embed complex nested interactive widgets inside NavRow
- Do not use NavRow as a button when simple Button component suffices

## Tags

navigation, sidebar, row, clickable, nav
