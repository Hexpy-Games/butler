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
Inside a `SidebarShell` the shell cancels the row inset for internally padded
action targets; text metadata keeps its normal trailing inset.
`density` (`compact`, `comfortable`, `touch`) sizes a standalone row; inside a
`SidebarShell` rows follow the shell's density. `reserveIcon` keeps an empty
icon column so a label-only row (for example "More (12)") aligns with iconned
rows. `NavRowSwap` is a trailing slot that shows its `rest` content (an
activity status, a disclosure chevron) at rest and swaps in row actions (a row
menu) on row hover, keyboard focus or while `open`; phones keep the rest
content and open row menus with a long press.

`NavRowChildren` nests rows under the NavRow just before it (a chat's
subtasks). It draws a 1px guide line, `--line`, centred on the parent's icon
column at `--sidebar-row-padding-inline` + `--sidebar-icon-size` / 2, so the
line follows the density (compact, comfortable, touch, and comfortable on
phones). Give the children `reserveIcon` so their labels start where the
parent's label starts; give their trailing slot the parent's shape (a
`NavRowSwap`, or an IconButton the width of the row menu) so their marks sit on
the parent's status column. Inside a `SidebarShell` it follows the shell's
density; standalone, pass the same `density` as the parent row.

```tsx
<NavRow icon={<Notebook />} label="Find the sign-in error" onClick={open} actions={rowMenu} />
<NavRowChildren>
  <NavRow reserveIcon label="Review the token refresh logic" onClick={openChild} actions={childSlot} />
</NavRowChildren>
```

## What is this block

NavRow is a Butler design-system block for building navigation rows with icon, label, optional badge, and inline actions.

## When to use this block

Use NavRow for sidebar navigation items, project rows, session rows, settings items, or any clickable list row in navigation context.

## Container vs Presenter

**NavRow is a presenter block.** It owns visual layout, states (active, disabled), hover behavior, and accessibility slots. The active row has primary text, medium label weight and a full-opacity icon. It must not import Butler domain data, stores, routes, or app copy.

### Fills

Fills are flat (no motion between rows, no shadow or edge) and come from the
surface the row sits on. NavRow reads `--nav-hover-bg` and
`--nav-selected-bg`; selected + hover and pressed show the selected fill.

- **Shades** (the default, when the surface sets neither): hover
  `--selection`, selected and pressed `--selection-strong` (75% of
  `--selection` inside a `SidebarShell`). A white base keeps them: web and
  Linux translucent, the hidden sidebar's peek card, the drawer, and all of
  dark theme.
- **White family** (light theme, a sidebar tinted against the content):
  AdaptiveShell maps the shell's pair onto the docked sidebar, and SettingsShell
  onto its nav in the cards frame. macOS translucent uses
  `--mac-sidebar-hover-bg` (white 0.45), Windows translucent
  `--windows-sidebar-hover-bg` (white 0.60), and the opaque sidebar setting
  (`.sidebar-solid`, every platform) `--sidebar-hover-bg` (white 0.60);
  selected is the workspace white (`--workspace-bg`). On the near-white
  Windows and opaque shells hover is faint by design and the medium label
  weight carries the selection.

The rule is the surface, never a platform check. NavRow's fills outrank
Clickable's.

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

### Disabled tone

Disabled options, menu items, rows and Clickables use the DS disabled tone:
`--interactive-disabled-fg` (the theme's `--color-text-disabled`) and
`--interactive-disabled-cursor`, never opacity, and they never take the hover
or keyboard highlight fill. Product code passes `disabled`; it does not style
the state.

## Accessibility

- Uses `role="button"` via Clickable when interactive
- Supports `aria-current="page"` for active state
- Accepts `ariaLabel` prop for screen readers
- Falls back to string label for accessible name
- Accepts `ariaDescription` for row state the name hides, such as Unread (the trailing marks sit inside the row's named button)

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
